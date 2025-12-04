import { BleManager, Device, Subscription } from "react-native-ble-plx";
import { Buffer } from "buffer";
import { parseBleNotificationPacket, resetBleParser } from "./bleParsing";
import { NewDetectionInput } from "./api";
import * as Location from 'expo-location';
import { estimateLocationSimple } from './locationUtils';

(global as any).Buffer = (global as any).Buffer || Buffer;

const ble = new BleManager();
const TARGET_DEVICE = { NAME: "nimble-bleprph", MAC: "80:F3:DA:54:EB:9A" };
const UUIDS = {
  NOTIFY_SERVICE: "0000fff0-0000-1000-8000-00805f9b34fb",
  NOTIFY_CHAR: "0000fff1-0000-1000-8000-00805f9b34fb",
  WRITE_SERVICE: "0000fff3-0000-1000-8000-00805f9b34fb",
  WRITE_CHAR: "0000fff2-0000-1000-8000-00805f9b34fb"
};

const LIVE_CONFIG = { BATCH_SIZE: 50, BATCH_TIMEOUT_MS: 5000 };

export type SimpleBleDevice = { id: string; name: string | null };
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

let activeLiveStream: { device: Device | null; subscription: Subscription | null; stopRequested: boolean } | null = null;

async function getUserLocation() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return null;
    
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    console.log('[Location] ✅', loc.coords.latitude, loc.coords.longitude);
    return { latitude: loc.coords.latitude, longitude: loc.coords.longitude };
  } catch (e) {
    console.error('[Location] Failed:', e);
    return null;
  }
}

/**
 * Write search mode to ESP32
 * @param device - Connected BLE device
 * @param targetMac - MAC address like "AA:BB:CC:DD:EE:FF" or null to deactivate
 * 
 * ESP expects 6 raw bytes, not ASCII string:
 * - To activate: [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]
 * - To deactivate: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
 */
async function writeSearchMode(device: Device, targetMac: string | null) {
  let macData: Buffer;
  
  if (targetMac) {
    // Convert "AA:BB:CC:DD:EE:FF" to [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]
    const parts = targetMac.toUpperCase().split(':');
    if (parts.length !== 6) {
      throw new Error(`Invalid MAC address format: ${targetMac}`);
    }
    const bytes = parts.map(hex => {
      const val = parseInt(hex, 16);
      if (isNaN(val)) {
        throw new Error(`Invalid hex value in MAC: ${hex}`);
      }
      return val;
    });
    macData = Buffer.from(bytes);
  } else {
    // Send 6 zero bytes to deactivate search mode
    macData = Buffer.from([0, 0, 0, 0, 0, 0]);
  }
  
  console.log('[BLE] Writing search mode bytes:', [...macData]);
  
  await device.writeCharacteristicWithResponseForService(
    UUIDS.WRITE_SERVICE,
    UUIDS.WRITE_CHAR,
    macData.toString('base64')
  );
  console.log('[BLE] Search mode:', targetMac || 'OFF');
}

export async function startSearchMode(deviceId: string, targetMac: string) {
  let device: Device | null = null;
  try {
    device = await ble.connectToDevice(deviceId, { timeout: 10000 });
    await device.discoverAllServicesAndCharacteristics();
    await writeSearchMode(device, targetMac);
  } finally {
    if (device) await device.cancelConnection().catch(() => {});
  }
}

export async function stopSearchMode(deviceId: string) {
  let device: Device | null = null;
  try {
    device = await ble.connectToDevice(deviceId, { timeout: 10000 });
    await device.discoverAllServicesAndCharacteristics();
    await writeSearchMode(device, null);
  } finally {
    if (device) await device.cancelConnection().catch(() => {});
  }
}

export async function activateSearchModeLive(targetMac: string) {
  if (!activeLiveStream?.device) throw new Error("No active live stream");
  await writeSearchMode(activeLiveStream.device, targetMac);
}

export async function deactivateSearchModeLive() {
  if (!activeLiveStream?.device) throw new Error("No active live stream");
  await writeSearchMode(activeLiveStream.device, null);
}

export async function scanForNearbyDevices(timeoutMs = 8000): Promise<SimpleBleDevice[]> {
  return new Promise((resolve) => {
    const seen = new Map<string, SimpleBleDevice>();
    
    ble.startDeviceScan(null, null, (error, device) => {
      if (error) { ble.stopDeviceScan(); resolve([]); return; }
      if (!device) return;
      
      const name = device.name ?? (device as any).localName ?? null;
      const isTarget = name === TARGET_DEVICE.NAME || (device as any).localName === TARGET_DEVICE.NAME;
      
      if (isTarget && !seen.has(device.id)) {
        seen.set(device.id, { id: device.id, name: name ?? "(unnamed)" });
        console.log('[BLE] Found:', device.id, name);
      }
    });

    setTimeout(() => { ble.stopDeviceScan(); resolve(Array.from(seen.values())); }, timeoutMs);
  });
}

// 🔵 FIXED: Robust error handling to prevent null error code crash
async function connectDevice(deviceId: string, timeoutMs = 15000): Promise<Device> {
  console.log('[BLE] === Safe Connect Starting ===');
  console.log('[BLE] Target device:', deviceId);
  
  const state = await ble.state();
  console.log('[BLE] BLE Manager state:', state);
  
  if (state !== 'PoweredOn') {
    throw new Error(`Bluetooth not ready: ${state}`);
  }
  
  // Clean up any existing connection
  try {
    const isConnected = await ble.isDeviceConnected(deviceId);
    console.log('[BLE] Device already connected?', isConnected);
    
    if (isConnected) {
      console.log('[BLE] Disconnecting existing connection...');
      await ble.cancelDeviceConnection(deviceId).catch(() => {});
      await new Promise(r => setTimeout(r, 500)); // Wait for disconnect to complete
    }
  } catch (e) {
    console.log('[BLE] Error checking connection status (non-fatal):', e);
  }
  
  console.log('[BLE] >>> Attempting connectToDevice with timeout:', timeoutMs);
  
  try {
    console.log('[BLE] >>> Waiting for connection...');
    const dev = await ble.connectToDevice(deviceId, { 
      timeout: timeoutMs, 
      requestMTU: 512,
      refreshGatt: 'OnConnected' // Force refresh GATT cache
    });
    console.log('[BLE] ✅ Connected successfully:', dev.id, dev.name);
    
    console.log('[BLE] >>> Discovering services...');
    const connectedDev = await dev.discoverAllServicesAndCharacteristics();
    console.log('[BLE] ✅ Services discovered');
    
    return connectedDev;
  } catch (e: any) {
    // 🔵 CRITICAL FIX: Always provide a non-null error message
    const errorMsg = e?.message || e?.toString() || 'Unknown BLE connection error';
    const errorCode = e?.errorCode || 'BLE_ERROR';
    
    console.error('[BLE] ❌ Connection failed:', errorMsg);
    console.error('[BLE] Error code:', errorCode);
    console.error('[BLE] Full error:', e);
    
    // Clean up connection state
    try {
      await ble.cancelDeviceConnection(deviceId).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    } catch {}
    
    // Throw a properly formatted error (non-null message)
    throw new Error(`BLE Connection Failed (${errorCode}): ${errorMsg}`);
  }
}

async function scanForDevice(targetName: string, targetMac: string): Promise<Device | null> {
  return new Promise((resolve) => {
    let resolved = false;
    
    ble.startDeviceScan(null, null, (error, device) => {
      if (error || !device) { if (!resolved) { resolved = true; ble.stopDeviceScan(); resolve(null); } return; }
      
      const name = device.name ?? (device as any).localName;
      if ((name === targetName || device.id === targetMac) && !resolved) {
        resolved = true;
        ble.stopDeviceScan();
        resolve(device);
      }
    });

    setTimeout(() => { if (!resolved) { resolved = true; ble.stopDeviceScan(); resolve(null); } }, 10000);
  });
}

export async function collectDetectionsLive(
  eventId: string | null,
  onDetectionBatch: LiveDetectionCallback,
  onStatusUpdate?: LiveStatusCallback,
  opts?: { deviceId?: string; timeoutMs?: number }
): Promise<LiveStreamStatus> {
  resetBleParser();
  
  const status: LiveStreamStatus = { isStreaming: true, detectionCount: 0, uploadedCount: 0, errorCount: 0, pendingCount: 0, lastDetection: null };
  let pendingDetections: NewDetectionInput[] = [];
  let uploadQueue: NewDetectionInput[][] = [];
  let isUploading = false;
  const timeoutMs = opts?.timeoutMs ?? 0;
  
  const userLocation = await getUserLocation();
  console.log('[BLE] ✅ Starting live stream at user location:', userLocation?.latitude, userLocation?.longitude);
  
  let connected: Device | null = null;
  let subscription: Subscription | null = null;
  let batchTimer: NodeJS.Timeout | null = null;

  const processQueue = async () => {
    if (isUploading || uploadQueue.length === 0) return;
    isUploading = true;
    
    while (uploadQueue.length > 0) {
      const batch = uploadQueue.shift()!;
      try {
        await onDetectionBatch(batch);
        status.uploadedCount += batch.length;
      } catch (e: any) {
        status.errorCount += batch.length;
        console.error('[BLE] Upload failed:', e?.message || 'Unknown error');
      }
      onStatusUpdate?.({ ...status });
      await new Promise(r => setTimeout(r, 100));
    }
    isUploading = false;
  };

  const queueBatch = () => {
    if (pendingDetections.length === 0) return;
    uploadQueue.push([...pendingDetections]);
    pendingDetections = [];
    status.pendingCount = 0;
    processQueue().catch(e => console.error('[BLE] Queue error:', e));
    onStatusUpdate?.({ ...status });
  };

  const resetTimer = () => {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => { queueBatch(); if (activeLiveStream && !activeLiveStream.stopRequested) resetTimer(); }, LIVE_CONFIG.BATCH_TIMEOUT_MS);
  };

  try {
    // 🔵 IMPROVED: Better device connection handling
    if (opts?.deviceId) {
      console.log('[BLE] connecting to selected device:', opts.deviceId);
      connected = await connectDevice(opts.deviceId);
    } else {
      console.log('[BLE] Scanning for default device...');
      const dev = await scanForDevice(TARGET_DEVICE.NAME, TARGET_DEVICE.MAC);
      if (!dev) throw new Error(`ESP32 device not found (looking for ${TARGET_DEVICE.NAME})`);
      console.log('[BLE] Found device, connecting...');
      connected = await connectDevice(dev.id);
    }

    activeLiveStream = { device: connected, subscription: null, stopRequested: false };
    resetTimer();

    console.log('[BLE] Setting up notification listener...');
    subscription = connected.monitorCharacteristicForService(UUIDS.NOTIFY_SERVICE, UUIDS.NOTIFY_CHAR, (error, char) => {
      if (error) {
        console.error('[BLE] Notification error:', error);
        return;
      }
      
      if (!char?.value || activeLiveStream?.stopRequested) return;
      
      try {
        const parsed = parseBleNotificationPacket(new Uint8Array(Buffer.from(char.value, 'base64')).buffer, eventId);
        if (!parsed) return;
        
        const detection: NewDetectionInput = { ...parsed };
        if (userLocation && parsed.estimated_distance && parsed.estimated_distance > 0) {
          const loc = estimateLocationSimple(userLocation, parsed.estimated_distance);
          detection.latitude = loc.latitude;
          detection.longitude = loc.longitude;
        }
        
        status.detectionCount++;
        status.lastDetection = detection;
        pendingDetections.push(detection);
        status.pendingCount = pendingDetections.length;
        
        if (pendingDetections.length >= LIVE_CONFIG.BATCH_SIZE) queueBatch();
        onStatusUpdate?.({ ...status });
      } catch (e) { 
        console.error('[BLE] Parse error:', e); 
      }
    });

    activeLiveStream.subscription = subscription;
    console.log('[BLE] ✅ Live stream monitoring active');

    if (timeoutMs > 0) {
      console.log('[BLE] Streaming for', timeoutMs, 'ms');
      await new Promise(r => setTimeout(r, timeoutMs));
    } else {
      console.log('[BLE] Streaming indefinitely until stopped...');
      await new Promise<void>(resolve => {
        const check = setInterval(() => {
          if (!activeLiveStream || activeLiveStream.stopRequested) { 
            console.log('[BLE] Stop detected, ending stream');
            clearInterval(check); 
            resolve(); 
          }
        }, 100);
      });
    }

    console.log('[BLE] Flushing remaining detections...');
    queueBatch();
    while (uploadQueue.length > 0 || isUploading) await new Promise(r => setTimeout(r, 200));

  } catch (e: any) {
    const errorMsg = e?.message || 'Unknown error during live stream';
    console.error('[BLE] Live stream failed:', errorMsg);
    status.isStreaming = false;
    throw new Error(errorMsg); // Re-throw with proper message
  } finally {
    if (batchTimer) clearTimeout(batchTimer);
    subscription?.remove();
    if (connected) {
      console.log('[BLE] Disconnecting...');
      await connected.cancelConnection().catch(() => {});
    }
    activeLiveStream = null;
    status.isStreaming = false;
  }

  console.log(`[BLE] Stream ended. Total: ${status.detectionCount}, Uploaded: ${status.uploadedCount}`);
  return status;
}

export function stopLiveStream() {
  if (activeLiveStream) {
    console.log('[BLE] Stop requested');
    activeLiveStream.stopRequested = true;
  } else {
    console.log('[BLE] No active live stream to stop');
  }
}

export function isLiveStreamActive() {
  return activeLiveStream !== null && !activeLiveStream.stopRequested;
}

export async function collectDetectionsFromEsp32(
  eventId: string | null,
  windowMs = 5000,
  opts?: { deviceId?: string }
): Promise<NewDetectionInput[]> {
  resetBleParser();
  const detections: NewDetectionInput[] = [];
  const userLocation = await getUserLocation();
  let connected: Device | null = null;

  try {
    connected = opts?.deviceId 
      ? await connectDevice(opts.deviceId, 10000)
      : await (async () => {
          const dev = await scanForDevice(TARGET_DEVICE.NAME, TARGET_DEVICE.MAC);
          if (!dev) throw new Error(`ESP32 not found`);
          return connectDevice(dev.id, 10000);
        })();

    connected.monitorCharacteristicForService(UUIDS.NOTIFY_SERVICE, UUIDS.NOTIFY_CHAR, (error, char) => {
      if (error || !char?.value) return;
      
      try {
        const parsed = parseBleNotificationPacket(new Uint8Array(Buffer.from(char.value, 'base64')).buffer, eventId);
        if (!parsed) return;
        
        const detection: NewDetectionInput = { ...parsed };
        if (userLocation && parsed.estimated_distance && parsed.estimated_distance > 0) {
          const loc = estimateLocationSimple(userLocation, parsed.estimated_distance);
          detection.latitude = loc.latitude;
          detection.longitude = loc.longitude;
        }
        detections.push(detection);
      } catch (e) { console.error('[BLE] Parse error:', e); }
    });

    await new Promise(r => setTimeout(r, windowMs));
    console.log(`[BLE] Collected ${detections.length} detections`);

  } catch (e: any) {
    const errorMsg = e?.message || 'Batch collection failed';
    console.error('[BLE] Batch collection error:', errorMsg);
    throw new Error(errorMsg);
  } finally {
    if (connected) await connected.cancelConnection().catch(() => {});
  }

  return detections;
}