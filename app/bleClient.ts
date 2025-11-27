// blustick/app/bleClient.ts - Enhanced with live streaming and search mode control

import { BleManager, Device, Subscription } from "react-native-ble-plx";
import { Buffer } from "buffer";
import { parseBleNotificationPacket, resetBleParser } from "./bleParsing";
import { NewDetectionInput } from "./api";
import * as Location from 'expo-location';
import { estimateLocationSimple } from './locationUtils';

(global as any).Buffer = (global as any).Buffer || Buffer;

const ble = new BleManager();

const TARGET_DEVICE_NAME = "nimble-bleprph";
const TARGET_DEVICE_MAC = "80:F3:DA:54:EB:9A";

const NOTIFY_SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb";
const NOTIFY_CHAR_UUID    = "0000fff1-0000-1000-8000-00805f9b34fb";

const WRITE_SERVICE_UUID  = "0000fff3-0000-1000-8000-00805f9b34fb";
const WRITE_CHAR_UUID     = "0000fff2-0000-1000-8000-00805f9b34fb";

export type SimpleBleDevice = {
  id: string;
  name: string | null;
};

export type SearchModeStatus = {
  isSearching: boolean;
  targetMac: string | null;
};

// Live streaming types
export type LiveDetectionCallback = (detections: NewDetectionInput[]) => Promise<void>;
export type LiveStatusCallback = (status: LiveStreamStatus) => void;

export type LiveStreamStatus = {
  isStreaming: boolean;
  detectionCount: number;
  uploadedCount: number;
  errorCount: number;
  pendingCount: number;
  lastDetection: NewDetectionInput | null;
};

// Configuration for live upload batching
const LIVE_BATCH_SIZE = 50; // Upload every 50 detections
const LIVE_BATCH_TIMEOUT_MS = 5000; // Or every 5 seconds, whichever comes first

// Store active live stream state for cleanup
let activeLiveStream: {
  device: Device | null;
  subscription: Subscription | null;
  stopRequested: boolean;
} | null = null;

async function getUserLocation(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    console.log('[Location] Requesting location permission...');
    
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      console.warn('[Location] Permission denied');
      return null;
    }

    console.log('[Location] Permission granted, getting position...');

    const location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });

    console.log('[Location] ✅ User position:', {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      accuracy: location.coords.accuracy,
    });

    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
    };
  } catch (error) {
    console.error('[Location] Failed to get user location:', error);
    return null;
  }
}

/**
 * Send a MAC address to the ESP32 to start searching for that device
 */
export async function startSearchMode(
  deviceId: string,
  targetMac: string
): Promise<void> {
  let device: Device | null = null;

  try {
    console.log("[BLE] Connecting to device for search mode:", deviceId);
    device = await ble.connectToDevice(deviceId, { timeout: 10000 });
    await device.discoverAllServicesAndCharacteristics();

    console.log("[BLE] Writing target MAC to start search:", targetMac);
    
    // Format MAC address (ensure uppercase, colon-separated)
    const formattedMac = targetMac.toUpperCase().replace(/[^0-9A-F:]/g, '');
    
    // Convert MAC string to bytes for writing
    const macBuffer = Buffer.from(formattedMac, 'ascii');
    const base64Mac = macBuffer.toString('base64');

    await device.writeCharacteristicWithResponseForService(
      WRITE_SERVICE_UUID,
      WRITE_CHAR_UUID,
      base64Mac
    );

    console.log("[BLE] ✅ Search mode activated for:", formattedMac);
  } catch (e) {
    console.error("[BLE] Failed to start search mode:", e);
    throw e;
  } finally {
    if (device) {
      try {
        await device.cancelConnection();
      } catch (e) {
        console.warn("[BLE] Error disconnecting:", e);
      }
    }
  }
}

/**
 * Send null/empty MAC to deactivate search mode
 */
export async function stopSearchMode(deviceId: string): Promise<void> {
  let device: Device | null = null;

  try {
    console.log("[BLE] Connecting to device to stop search mode:", deviceId);
    device = await ble.connectToDevice(deviceId, { timeout: 10000 });
    await device.discoverAllServicesAndCharacteristics();

    console.log("[BLE] Sending null MAC to deactivate search");
    
    // Send empty/null MAC address (6 zero bytes)
    const nullMac = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const base64NullMac = nullMac.toString('base64');

    await device.writeCharacteristicWithResponseForService(
      WRITE_SERVICE_UUID,
      WRITE_CHAR_UUID,
      base64NullMac
    );

    console.log("[BLE] ✅ Search mode deactivated");
  } catch (e) {
    console.error("[BLE] Failed to stop search mode:", e);
    throw e;
  } finally {
    if (device) {
      try {
        await device.cancelConnection();
      } catch (e) {
        console.warn("[BLE] Error disconnecting:", e);
      }
    }
  }
}

export async function scanForNearbyDevices(
  timeoutMs = 8000
): Promise<SimpleBleDevice[]> {
  return new Promise((resolve) => {
    const seen = new Map<string, SimpleBleDevice>();

    console.log("[BLE] starting general scan for nearby devices…");

    ble.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error("[BLE] scan error:", error);
        ble.stopDeviceScan();
        resolve([]);
        return;
      }

      if (!device) return;

      const name = device.name ?? (device as any).localName ?? null;
      const isTarget = name === TARGET_DEVICE_NAME || (device as any).localName === TARGET_DEVICE_NAME;

      if (!isTarget) return;

      if (!seen.has(device.id)) {
        seen.set(device.id, { id: device.id, name: name ?? "(unnamed device)" });
        console.log("[BLE] discovered TARGET device ->", device.id, name);
      }
    });

    setTimeout(() => {
      console.log("[BLE] general scan timeout, stopping scan");
      ble.stopDeviceScan();
      resolve(Array.from(seen.values()));
    }, timeoutMs);
  });
}

async function logServicesAndCharacteristics(device: Device) {
  try {
    const services = await device.services();
    console.log("[BLE] ---- SERVICES / CHARACTERISTICS ----");
    for (const svc of services) {
      console.log("  [Service]", svc.uuid);
      const chars = await svc.characteristics();
      for (const ch of chars) {
        console.log(
          "    [Char] uuid=",
          ch.uuid,
          " isNotifiable=",
          ch.isNotifiable,
          " isWritableWithResponse=",
          ch.isWritableWithResponse,
          " isWritableWithoutResponse=",
          ch.isWritableWithoutResponse
        );
      }
    }
    console.log("[BLE] ---- END SERVICES ----");
  } catch (e) {
    console.error("[BLE] error while logging services/chars:", e);
  }
}

/**
 * NEW: Live streaming detection collection with batched real-time upload
 * Uses a separate upload queue to keep BLE connection stable
 */
export async function collectDetectionsLive(
  eventId: string | null,
  onDetectionBatch: LiveDetectionCallback,
  onStatusUpdate?: LiveStatusCallback,
  opts?: { deviceId?: string; timeoutMs?: number }
): Promise<LiveStreamStatus> {
  resetBleParser();

  const status: LiveStreamStatus = {
    isStreaming: true,
    detectionCount: 0,
    uploadedCount: 0,
    errorCount: 0,
    pendingCount: 0,
    lastDetection: null,
  };

  // Buffer for batching detections
  let pendingDetections: NewDetectionInput[] = [];
  let isUploading = false;
  let uploadQueue: NewDetectionInput[][] = [];

  const timeoutMs = opts?.timeoutMs ?? 0; // 0 = no timeout (manual stop)

  console.log('[BLE] 🔴 Starting LIVE streaming mode (stable connection)...');
  console.log('[BLE] Getting user location for detection estimation...');
  
  const userLocation = await getUserLocation();
  
  if (userLocation) {
    console.log('[BLE] ✅ Starting live stream at user location:', 
      `${userLocation.latitude.toFixed(6)}, ${userLocation.longitude.toFixed(6)}`);
  } else {
    console.warn('[BLE] ⚠️ No GPS location available - detections will have null lat/lon');
  }

  let connected: Device | null = null;
  let subscription: Subscription | null = null;

  // Background upload processor - runs independently of BLE callbacks
  const processUploadQueue = async () => {
    if (isUploading || uploadQueue.length === 0) return;
    
    isUploading = true;
    
    while (uploadQueue.length > 0) {
      const batch = uploadQueue.shift()!;
      
      try {
        console.log(`[BLE] 🔴 LIVE: Uploading batch of ${batch.length} detections...`);
        const batchSizeBytes = JSON.stringify(batch).length;
        console.log(`[BLE] 📦 Batch payload size: ${(batchSizeBytes / 1024).toFixed(2)} KB`);
        await onDetectionBatch(batch);
        status.uploadedCount += batch.length;
        console.log(`[BLE] ✅ LIVE: Batch uploaded. Total: ${status.uploadedCount}`);
      } catch (uploadError: any) {
        status.errorCount += batch.length;
        console.error(`[BLE] ❌ LIVE: Batch upload failed:`, uploadError);
        console.error(`[BLE] ❌ Error details:`, uploadError?.message, uploadError?.response?.status);
      }

      // Update status after each batch
      if (onStatusUpdate) {
        onStatusUpdate({ ...status });
      }
      
      // Small delay between batches to prevent overwhelming the server
      await new Promise(r => setTimeout(r, 100));
    }
    
    isUploading = false;
  };

  // Function to queue pending detections for upload (non-blocking)
  const queuePendingDetections = () => {
    if (pendingDetections.length === 0) return;
    
    const batch = [...pendingDetections];
    pendingDetections = [];
    status.pendingCount = 0;
    
    // Add to upload queue (don't await - let it process in background)
    uploadQueue.push(batch);
    console.log(`[BLE] 📤 Queued batch of ${batch.length} for upload (queue size: ${uploadQueue.length})`);
    
    // Trigger upload processor (non-blocking)
    processUploadQueue().catch(err => {
      console.error('[BLE] Upload processor error:', err);
    });

    if (onStatusUpdate) {
      onStatusUpdate({ ...status });
    }
  };

  // Batch timer
  let batchTimer: NodeJS.Timeout | null = null;
  
  const resetBatchTimer = () => {
    if (batchTimer) {
      clearTimeout(batchTimer);
    }
    batchTimer = setTimeout(() => {
      queuePendingDetections();
      // Reset timer for next batch
      if (activeLiveStream && !activeLiveStream.stopRequested) {
        resetBatchTimer();
      }
    }, LIVE_BATCH_TIMEOUT_MS);
  };

  try {
    if (opts?.deviceId) {
      console.log("[BLE] connecting to selected device:", opts.deviceId);
      const dev = await ble.connectToDevice(opts.deviceId, { timeout: 15000 });
      connected = await dev.discoverAllServicesAndCharacteristics();
    } else {
      console.log("[BLE] starting scan for default ESP32…");
      const device = await scanForDevice(TARGET_DEVICE_NAME, TARGET_DEVICE_MAC);
      if (!device) {
        throw new Error(
          `Could not find ESP32 (expected name "${TARGET_DEVICE_NAME}" or MAC "${TARGET_DEVICE_MAC}")`
        );
      }
      console.log("[BLE] found default device:", device.id, device.name);
      const dev = await device.connect();
      connected = await dev.discoverAllServicesAndCharacteristics();
    }

    console.log("[BLE] connected to device:", connected.id, connected.name);

    // MTU negotiation
    try {
      const currentMtu = connected.mtu;
      console.log("[BLE] current MTU:", currentMtu);
      
      if (currentMtu < 83) {
        console.log("[BLE] requesting MTU of 512 bytes...");
        await connected.requestMTU(512);
        const newMtu = connected.mtu;
        console.log("[BLE] ✅ MTU negotiated to:", newMtu, "bytes");
        
        if (newMtu < 83) {
          console.warn("[BLE] ⚠️ MTU is still too small for 80-byte packets!");
        }
      } else {
        console.log("[BLE] ✅ MTU is already sufficient:", currentMtu);
      }
    } catch (mtuError) {
      console.error("[BLE] MTU negotiation failed:", mtuError);
    }

    await logServicesAndCharacteristics(connected);

    console.log(
      "[BLE] 🔴 LIVE: starting notifications on service =",
      NOTIFY_SERVICE_UUID,
      " char =",
      NOTIFY_CHAR_UUID
    );

    // Store for cleanup
    activeLiveStream = {
      device: connected,
      subscription: null,
      stopRequested: false,
    };

    // Start batch timer
    resetBatchTimer();

    // Monitor for disconnection
    connected.onDisconnected((error, device) => {
      console.log('[BLE] ⚠️ Device disconnected!', error?.message || 'No error');
      if (activeLiveStream && !activeLiveStream.stopRequested) {
        console.log('[BLE] Unexpected disconnection - marking stream as stopped');
        activeLiveStream.stopRequested = true;
      }
    });

    subscription = connected.monitorCharacteristicForService(
      NOTIFY_SERVICE_UUID,
      NOTIFY_CHAR_UUID,
      (error, characteristic) => {
        // IMPORTANT: Keep this callback synchronous and fast!
        if (error) {
          console.error("[BLE] monitor error:", error);
          return;
        }
        if (!characteristic?.value) return;
        if (activeLiveStream?.stopRequested) return;

        try {
          const buf = Buffer.from(characteristic.value, "base64");
          const bytes = new Uint8Array(buf);
          const parsed = parseBleNotificationPacket(bytes.buffer, eventId);
          
          if (parsed) {
            const detection: NewDetectionInput = { ...parsed };

            if (userLocation && parsed.estimated_distance && parsed.estimated_distance > 0) {
              const estimatedLocation = estimateLocationSimple(
                userLocation,
                parsed.estimated_distance
              );
              
              detection.latitude = estimatedLocation.latitude;
              detection.longitude = estimatedLocation.longitude;
            }
            
            status.detectionCount++;
            status.lastDetection = detection;

            // Add to pending batch (synchronous - no await!)
            pendingDetections.push(detection);
            status.pendingCount = pendingDetections.length;

            console.log(`[BLE] 🔴 Detection #${status.detectionCount} - ${detection.mac_address} (pending: ${status.pendingCount})`);

            // Check if we should queue for upload
            if (pendingDetections.length >= LIVE_BATCH_SIZE) {
              queuePendingDetections();
            }

            // Notify status update
            if (onStatusUpdate) {
              onStatusUpdate({ ...status });
            }
          }
        } catch (e) {
          console.error("[BLE] parse error:", e);
        }
      }
    );

    activeLiveStream.subscription = subscription;

    // If timeout specified, wait for it
    if (timeoutMs > 0) {
      console.log("[BLE] 🔴 LIVE: streaming for", timeoutMs, "ms…");
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      console.log("[BLE] 🔴 LIVE: timeout reached, stopping...");
    } else {
      // No timeout - stream continues until stopLiveStream() called
      console.log("[BLE] 🔴 LIVE: streaming indefinitely until manually stopped...");
      
      // Return a promise that resolves when stop is requested
      await new Promise<void>((resolve) => {
        const checkStop = setInterval(() => {
          if (activeLiveStream?.stopRequested) {
            clearInterval(checkStop);
            resolve();
          }
        }, 100);
      });
    }

    // Queue any remaining detections
    queuePendingDetections();
    
    // Wait for upload queue to finish
    console.log('[BLE] Waiting for upload queue to finish...');
    while (uploadQueue.length > 0 || isUploading) {
      await new Promise(r => setTimeout(r, 200));
    }

  } catch (e) {
    console.error("[BLE] collectDetectionsLive FAILED:", e);
    status.isStreaming = false;
    throw e;
  } finally {
    // Clear batch timer
    if (batchTimer) {
      clearTimeout(batchTimer);
    }
    
    // Cleanup
    if (subscription) {
      subscription.remove();
    }
    if (connected) {
      try {
        await connected.cancelConnection();
        console.log('[BLE] Disconnected from device');
      } catch (e) {
        console.warn("[BLE] Error disconnecting:", e);
      }
    }
    activeLiveStream = null;
    status.isStreaming = false;
  }

  console.log(`[BLE] 🔴 LIVE: Stream ended. Total: ${status.detectionCount}, Uploaded: ${status.uploadedCount}, Errors: ${status.errorCount}`);
  return status;
}

/**
 * Stop an active live stream
 */
export function stopLiveStream(): void {
  if (activeLiveStream) {
    console.log("[BLE] 🛑 Stopping live stream...");
    activeLiveStream.stopRequested = true;
  } else {
    console.log("[BLE] No active live stream to stop");
  }
}

/**
 * Check if live stream is currently active
 */
export function isLiveStreamActive(): boolean {
  return activeLiveStream !== null && !activeLiveStream.stopRequested;
}

/**
 * Original batch collection (kept for backwards compatibility)
 */
export async function collectDetectionsFromEsp32(
  eventId: string | null,
  windowMs = 5000,
  opts?: { deviceId?: string }
): Promise<NewDetectionInput[]> {
  resetBleParser();

  const detections: NewDetectionInput[] = [];

  console.log('[BLE] Getting user location for detection estimation...');
  const userLocation = await getUserLocation();
  
  if (userLocation) {
    console.log('[BLE] ✅ Starting scan at user location:', 
      `${userLocation.latitude.toFixed(6)}, ${userLocation.longitude.toFixed(6)}`);
  } else {
    console.warn('[BLE] ⚠️ No GPS location available - detections will have null lat/lon');
  }

  let connected: Device | null = null;

  try {
    if (opts?.deviceId) {
      console.log("[BLE] connecting to selected device:", opts.deviceId);
      const dev = await ble.connectToDevice(opts.deviceId, { timeout: 10000 });
      connected = await dev.discoverAllServicesAndCharacteristics();
    } else {
      console.log("[BLE] starting scan for default ESP32…");
      const device = await scanForDevice(TARGET_DEVICE_NAME, TARGET_DEVICE_MAC);
      if (!device) {
        throw new Error(
          `Could not find ESP32 (expected name "${TARGET_DEVICE_NAME}" or MAC "${TARGET_DEVICE_MAC}")`
        );
      }
      console.log("[BLE] found default device:", device.id, device.name);
      const dev = await device.connect();
      connected = await dev.discoverAllServicesAndCharacteristics();
    }

    console.log("[BLE] connected to device:", connected.id, connected.name);

    // MTU negotiation
    try {
      const currentMtu = connected.mtu;
      console.log("[BLE] current MTU:", currentMtu);
      
      if (currentMtu < 83) {
        console.log("[BLE] requesting MTU of 512 bytes...");
        await connected.requestMTU(512);
        const newMtu = connected.mtu;
        console.log("[BLE] ✅ MTU negotiated to:", newMtu, "bytes");
        
        if (newMtu < 83) {
          console.warn("[BLE] ⚠️ MTU is still too small for 80-byte packets!");
        }
      } else {
        console.log("[BLE] ✅ MTU is already sufficient:", currentMtu);
      }
    } catch (mtuError) {
      console.error("[BLE] MTU negotiation failed:", mtuError);
    }

    await logServicesAndCharacteristics(connected);

    console.log(
      "[BLE] starting notifications on service =",
      NOTIFY_SERVICE_UUID,
      " char =",
      NOTIFY_CHAR_UUID
    );

    connected.monitorCharacteristicForService(
      NOTIFY_SERVICE_UUID,
      NOTIFY_CHAR_UUID,
      (error, characteristic) => {
        if (error) {
          console.error("[BLE] monitor error:", error);
          return;
        }
        if (!characteristic?.value) return;

        try {
          const buf = Buffer.from(characteristic.value, "base64");
          const bytes = new Uint8Array(buf);
          const parsed = parseBleNotificationPacket(bytes.buffer, eventId);
          
          if (parsed) {
            const detection: NewDetectionInput = { ...parsed };

            if (userLocation && parsed.estimated_distance && parsed.estimated_distance > 0) {
              const estimatedLocation = estimateLocationSimple(
                userLocation,
                parsed.estimated_distance
              );
              
              detection.latitude = estimatedLocation.latitude;
              detection.longitude = estimatedLocation.longitude;
              
              console.log(
                `[BLE] 📍 Estimated location for ${parsed.mac_address}:`,
                `${estimatedLocation.latitude.toFixed(6)}, ${estimatedLocation.longitude.toFixed(6)}`,
                `(${parsed.estimated_distance.toFixed(1)}m from user)`
              );
            }
            
            detections.push(detection);
          }
        } catch (e) {
          console.error("[BLE] parse error:", e);
        }
      }
    );

    console.log("[BLE] collecting notifications for", windowMs, "ms…");
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    
    console.log("[BLE] collection complete, letting subscription clean up naturally...");
    console.log("[BLE] collected", detections.length, "detections total");
    
    const withLocation = detections.filter(d => d.latitude !== null && d.longitude !== null).length;
    console.log(`[BLE] 📍 ${withLocation}/${detections.length} detections have GPS coordinates`);

  } catch (e) {
    console.error("[BLE] collectDetectionsFromEsp32 FAILED:", e);
    throw e;
  }

  return detections;
}

async function scanForDevice(
  targetName: string,
  targetMac: string
): Promise<Device | null> {
  return new Promise((resolve) => {
    let resolved = false;

    console.log("[BLE] targeted scan for", targetName, targetMac);

    ble.startDeviceScan(null, null, (error, device) => {
      if (error) {
        console.error("[BLE] scan error:", error);
        if (!resolved) {
          resolved = true;
          ble.stopDeviceScan();
          resolve(null);
        }
        return;
      }

      if (!device) return;

      const name = device.name ?? (device as any).localName ?? "(unnamed device)";
      const nameMatches = device.name === targetName || (device as any).localName === targetName;
      const macMatches = device.id === targetMac;

      if (nameMatches || macMatches) {
        console.log("[BLE] found target during scan:", device.id, name);
        if (!resolved) {
          resolved = true;
          ble.stopDeviceScan();
          resolve(device);
        }
      }
    });

    setTimeout(() => {
      if (!resolved) {
        console.warn("[BLE] scan timeout (10s) – did not find target device");
        resolved = true;
        ble.stopDeviceScan();
        resolve(null);
      }
    }, 10000);
  });
}