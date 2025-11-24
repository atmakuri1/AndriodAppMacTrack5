// blustick/app/bleClient.ts - Workaround: Don't call remove()

import { BleManager, Device, Subscription, BleError } from "react-native-ble-plx";
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

const SERVICE_UUID = NOTIFY_SERVICE_UUID;
const CHAR_UUID    = NOTIFY_CHAR_UUID;

export type SimpleBleDevice = {
  id: string;
  name: string | null;
};

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

      const name =
        device.name ?? (device as any).localName ?? null;

      const isTarget =
        name === TARGET_DEVICE_NAME ||
        (device as any).localName === TARGET_DEVICE_NAME;

      if (!isTarget) {
        return;
      }

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
      SERVICE_UUID,
      " char =",
      CHAR_UUID
    );

    // 🔧 KEY FIX: Don't store subscription reference, don't call remove()
    connected.monitorCharacteristicForService(
      SERVICE_UUID,
      CHAR_UUID,
      (error, characteristic) => {
        if (error) {
          console.error("[BLE] monitor error:", error);
          return;
        }
        if (!characteristic?.value) {
          return;
        }

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

  // Let BLE library handle cleanup naturally
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

      const name =
        device.name ?? (device as any).localName ?? "(unnamed device)";

      const nameMatches =
        device.name === targetName ||
        (device as any).localName === targetName;

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
        console.warn(
          "[BLE] scan timeout (10s) – did not find target device"
        );
        resolved = true;
        ble.stopDeviceScan();
        resolve(null);
      }
    }, 10000);
  });
}