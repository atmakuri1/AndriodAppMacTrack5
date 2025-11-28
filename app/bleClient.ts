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
 * This version connects, writes, and disconnects (for use when NOT live streaming)
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
 * This version connects, writes, and disconnects (for use when NOT live streaming)
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

/**
 * Activate search mode on an ALREADY CONNECTED device (during live streaming)
 * Does NOT disconnect - keeps the connection alive
 */
export async function activateSearchModeLive(targetMac: string): Promise<void> {
  if (!activeLiveStream?.device) {
    throw new Error("No active live stream - cannot activate search mode");
  }

  const device = activeLiveStream.device;
  
  try {
    console.log("[BLE] 🎯 Activating search mode (live) for:", targetMac);
    
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

    console.log("[BLE] ✅ Search mode activated (live) for:", formattedMac);
  } catch (e) {
    console.error("[BLE] Failed to activate search mode (live):", e);
    throw e;
  }
  // NOTE: Do NOT disconnect - keep streaming
}

/**
 * Deactivate search mode on an ALREADY CONNECTED device (during live streaming)
 * Does NOT disconnect - keeps the connection alive
 */
export async function deactivateSearchModeLive(): Promise<void> {
  if (!activeLiveStream?.device) {
    throw new Error("No active live stream - cannot deactivate search mode");
  }

  const device = activeLiveStream.device;
  
  try {
    console.log("[BLE] 🔄 Deactivating search mode (live)...");
    
    // Send empty/null MAC address (6 zero bytes)
    const nullMac = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const base64NullMac = nullMac.toString('base64');

    await device.writeCharacteristicWithResponseForService(
      WRITE_SERVICE_UUID,
      WRITE_CHAR_UUID,
      base64NullMac
    );

    console.log("[BLE] ✅ Search mode deactivated (live) - tracking all devices");
  } catch (e) {
    console.error("[BLE] Failed to deactivate search mode (live):", e);
    throw e;
  }
  // NOTE: Do NOT disconnect - keep streaming
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
 * Helper function to safely connect to a BLE device with proper state checking
 */
async function safeConnectToDevice(deviceId: string, timeoutMs: number = 15000): Promise<Device> {
  console.log("[BLE] === Safe Connect Starting ===");
  console.log("[BLE] Target device:", deviceId);
  
  // 1. Check BLE state first
  const bleState = await ble.state();
  console.log("[BLE] BLE Manager state:", bleState);
  
  if (bleState !== 'PoweredOn') {
    throw new Error(`Bluetooth is not ready. State: ${bleState}`);
  }
  
  // 2. Cancel any existing connection to this device
  try {
    const isConnected = await ble.isDeviceConnected(deviceId);
    console.log("[BLE] Device already connected?", isConnected);
    
    if (isConnected) {
      console.log("[BLE] Disconnecting existing connection...");
      await ble.cancelDeviceConnection(deviceId);
      await new Promise(r => setTimeout(r, 1000));
      console.log("[BLE] Existing connection cancelled");
    }
  } catch (e: any) {
    // Also try to cancel even if isDeviceConnected fails
    try {
      await ble.cancelDeviceConnection(deviceId);
    } catch {}
    console.log("[BLE] Cleanup attempt complete");
  }
  
  // 3. Connect with explicit timeout handling
  console.log("[BLE] >>> Attempting connectToDevice with timeout:", timeoutMs);
  
  const connectionPromise = ble.connectToDevice(deviceId, { 
    timeout: timeoutMs,
    requestMTU: 512 
  });
  
  // Add our own timeout wrapper since BLE library timeout sometimes doesn't fire
  const manualTimeoutMs = timeoutMs + 5000; // Extra 5s buffer
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Connection timeout (manual ${manualTimeoutMs}ms)`));
    }, manualTimeoutMs);
  });
  
  console.log("[BLE] >>> Waiting for connection...");
  let dev: Device;
  try {
    dev = await Promise.race([connectionPromise, timeoutPromise]);
  } catch (connectError: any) {
    console.error("[BLE] Connection failed:", connectError?.message || connectError);
    throw new Error(connectError?.message || "Failed to connect to device. Make sure it's nearby and not connected to another phone.");
  }
  
  console.log("[BLE] >>> connectToDevice returned successfully!");
  console.log("[BLE] >>> Device ID:", dev.id);
  console.log("[BLE] >>> Device Name:", dev.name);
  
  return dev;
}

/**
 * Live streaming detection collection with batched real-time upload
 * Uses a separate upload queue to keep BLE connection stable
 */
export async function collectDetectionsLive(
  eventId: string | null,
  onDetectionBatch: LiveDetectionCallback,
  onStatusUpdate?: LiveStatusCallback,
  opts?: { deviceId?: string; timeoutMs?: number }
): Promise<LiveStreamStatus> {
  resetBleParser();

  console.log('[BLE] ====== LIVE STREAM START ======');
  console.log('[BLE] eventId:', eventId);
  console.log('[BLE] deviceId:', opts?.deviceId);
  console.log('[BLE] timeoutMs:', opts?.timeoutMs);

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
        await onDetectionBatch(batch);
        status.uploadedCount += batch.length;
        console.log(`[BLE] ✅ Batch uploaded. Total uploaded: ${status.uploadedCount}`);
      } catch (uploadError: any) {
        status.errorCount += batch.length;
        console.error(`[BLE] ❌ Batch upload failed:`, uploadError?.message);
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
    console.log(`[BLE] 📤 Queued ${batch.length} detections (queue: ${uploadQueue.length})`);
    
    // Trigger upload processor (non-blocking)
    processUploadQueue().catch(err => {
      console.error('[BLE] ❌ Upload processor error:', err);
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
      
      // Use safe connection helper
      const dev = await safeConnectToDevice(opts.deviceId, 15000);
      
      console.log("[BLE] >>> Discovering services and characteristics...");
      connected = await dev.discoverAllServicesAndCharacteristics();
      console.log("[BLE] >>> Services discovered successfully!");
      
    } else {
      console.log("[BLE] starting scan for default ESP32…");
      const device = await scanForDevice(TARGET_DEVICE_NAME, TARGET_DEVICE_MAC);
      if (!device) {
        throw new Error(
          `Could not find ESP32 (expected name "${TARGET_DEVICE_NAME}" or MAC "${TARGET_DEVICE_MAC}")`
        );
      }
      console.log("[BLE] found default device:", device.id, device.name);
      
      // Use safe connection for default device too
      const dev = await safeConnectToDevice(device.id, 15000);
      connected = await dev.discoverAllServicesAndCharacteristics();
    }

    console.log("[BLE] connected to device:", connected.id, connected.name);

    // MTU negotiation (may already be done in safeConnectToDevice, but check again)
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

    // Store for cleanup AND for search mode access
    activeLiveStream = {
      device: connected,
      subscription: null,
      stopRequested: false,
    };

    // Start batch timer
    resetBatchTimer();

    // Monitor for disconnection - but don't auto-stop on expected disconnections
    const disconnectSubscription = connected.onDisconnected((error, device) => {
      console.log('[BLE] ⚠️ Device disconnected event received');
      console.log('[BLE] Error:', error?.message || 'No error');
      console.log('[BLE] Stop requested:', activeLiveStream?.stopRequested);
      
      // Only mark as stopped if we didn't request the stop
      if (activeLiveStream && !activeLiveStream.stopRequested) {
        console.log('[BLE] ❌ Unexpected disconnection - will end stream');
        activeLiveStream.stopRequested = true;
      }
    });

    console.log('[BLE] 🔴 Starting characteristic monitoring...');

    subscription = connected.monitorCharacteristicForService(
      NOTIFY_SERVICE_UUID,
      NOTIFY_CHAR_UUID,
      (error, characteristic) => {
        // IMPORTANT: Keep this callback synchronous and fast!
        if (error) {
          console.error("[BLE] ❌ MONITOR ERROR:", error);
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

            // Only log every 50 detections to reduce noise
            if (status.detectionCount % 50 === 0) {
              console.log(`[BLE] 📊 Progress: ${status.detectionCount} detected, ${status.uploadedCount} uploaded, ${status.pendingCount} pending`);
            }

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

    console.log('[BLE] 🔴 Monitoring started successfully');

    // If timeout specified, wait for it
    if (timeoutMs > 0) {
      console.log("[BLE] 🔴 LIVE: streaming for", timeoutMs, "ms…");
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
      console.log("[BLE] 🔴 LIVE: timeout reached, stopping...");
    } else {
      // No timeout - stream continues until stopLiveStream() called
      console.log("[BLE] 🔴 LIVE: streaming indefinitely until manually stopped...");
      console.log("[BLE] 🔴 LIVE: stopRequested =", activeLiveStream?.stopRequested);
      
      // Return a promise that resolves when stop is requested
      await new Promise<void>((resolve) => {
        const checkStop = setInterval(() => {
          // Log every 10 seconds to show we're still running
          if (status.detectionCount % 100 === 0 && status.detectionCount > 0) {
            console.log(`[BLE] 🔴 Still streaming... detections: ${status.detectionCount}, stopRequested: ${activeLiveStream?.stopRequested}`);
          }
          
          if (!activeLiveStream || activeLiveStream.stopRequested) {
            console.log('[BLE] 🔴 Stop condition met, ending stream loop');
            console.log('[BLE] activeLiveStream exists:', !!activeLiveStream);
            console.log('[BLE] stopRequested:', activeLiveStream?.stopRequested);
            clearInterval(checkStop);
            resolve();
          }
        }, 100);
      });
    }

    console.log('[BLE] 🔴 Main loop ended, processing remaining queue...');

    // Queue any remaining detections
    queuePendingDetections();
    
    // Wait for upload queue to finish
    console.log('[BLE] Waiting for upload queue to finish... queue size:', uploadQueue.length, 'isUploading:', isUploading);
    let waitCount = 0;
    while (uploadQueue.length > 0 || isUploading) {
      await new Promise(r => setTimeout(r, 200));
      waitCount++;
      if (waitCount % 25 === 0) { // Log every 5 seconds
        console.log('[BLE] Still waiting for uploads... queue:', uploadQueue.length, 'uploading:', isUploading);
      }
    }
    console.log('[BLE] Upload queue finished');

  } catch (e) {
    console.error("[BLE] ====== LIVE STREAM ERROR ======");
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
      try {
        subscription.remove();
      } catch (e) {
        console.warn("[BLE] Error removing subscription:", e);
      }
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
      
      // Use safe connection helper for batch sync too
      const dev = await safeConnectToDevice(opts.deviceId, 10000);
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
      const dev = await safeConnectToDevice(device.id, 10000);
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
  } finally {
    // Clean up connection
    if (connected) {
      try {
        await connected.cancelConnection();
        console.log('[BLE] Batch sync: Disconnected from device');
      } catch (e) {
        console.warn("[BLE] Error disconnecting:", e);
      }
    }
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