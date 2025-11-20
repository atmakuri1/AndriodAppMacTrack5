// blustick/app/bleClient.ts
import { BleManager, Device, Subscription, BleError } from "react-native-ble-plx";
import { Buffer } from "buffer";
import { parseBleNotificationPacket, resetBleParser } from "./bleParsing";
import { NewDetectionInput } from "./api";

// Polyfill Buffer if needed
(global as any).Buffer = (global as any).Buffer || Buffer;

const ble = new BleManager();

// From your scan: name + MAC (MAC just fallback)
const TARGET_DEVICE_NAME = "nimble-bleprph";
const TARGET_DEVICE_MAC = "80:F3:DA:54:EB:9A";

// Firmware 16-bit UUIDs, expanded:
const NOTIFY_SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"; // upload_svc_uuid
const NOTIFY_CHAR_UUID    = "0000fff1-0000-1000-8000-00805f9b34fb"; // upload_chr_uuid

const WRITE_SERVICE_UUID  = "0000fff3-0000-1000-8000-00805f9b34fb"; // write_svc_uuid
const WRITE_CHAR_UUID     = "0000fff2-0000-1000-8000-00805f9b34fb"; // recieve_chr_uuid

// For reading detections:
const SERVICE_UUID = NOTIFY_SERVICE_UUID;
const CHAR_UUID    = NOTIFY_CHAR_UUID;

export type SimpleBleDevice = {
  id: string;
  name: string | null;
};

/**
 * Scan for nearby BLE devices for a short time and return a unique list,
 * filtered so we ONLY keep devices with the ESP32 name (nimble-bleprph).
 */
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

      // 🔍 Only keep devices that match the ESP name
      const isTarget =
        name === TARGET_DEVICE_NAME ||
        (device as any).localName === TARGET_DEVICE_NAME;

      if (!isTarget) {
        return; // ignore earbuds, laptops, etc.
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

/**
 * Dump all services + characteristics so we can verify UUIDs.
 */
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
 * Scan (or connect directly) → subscribe to notifications → collect packets for `windowMs`.
 * If `opts.deviceId` is passed, we connect directly to that device.
 * Otherwise we look for the default TARGET_DEVICE_NAME / MAC.
 */
export async function collectDetectionsFromEsp32(
  eventId: string | null,
  windowMs = 5000,
  opts?: { deviceId?: string }
): Promise<NewDetectionInput[]> {
  // 🔄 Reset per collection so bootEpochMs is fresh
  resetBleParser();

  const detections: NewDetectionInput[] = [];

  let connected: Device;

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

    // 🔥 REQUEST HIGHER MTU TO RECEIVE 80-BYTE PACKETS
    try {
      const currentMtu = connected.mtu; // It's a property, not a method
      console.log("[BLE] current MTU:", currentMtu);
      
      if (currentMtu < 83) { // Need at least 80 bytes + 3 bytes ATT overhead
        console.log("[BLE] requesting MTU of 512 bytes...");
        await connected.requestMTU(512); // Returns Device, not the MTU value
        const newMtu = connected.mtu; // Read the property again after requesting
        console.log("[BLE] ✅ MTU negotiated to:", newMtu, "bytes");
        
        if (newMtu < 83) {
          console.warn("[BLE] ⚠️ MTU is still too small for 80-byte packets! Will receive in chunks.");
        }
      } else {
        console.log("[BLE] ✅ MTU is already sufficient:", currentMtu);
      }
    } catch (mtuError) {
      console.error("[BLE] MTU negotiation failed:", mtuError);
      console.warn("[BLE] ⚠️ Will receive packets in 20-byte chunks");
    }

    // Log disconnects
    ble.onDeviceDisconnected(
      connected.id,
      (error: BleError | null, device: Device | null) => {
        if (error) {
          console.log("[BLE] Disconnect error:", {
            message: error.message,
            errorCode: error.errorCode,
            errorName: error.name,
          });
        } else {
          console.log(
            "[BLE] Disconnected from device:",
            device?.id,
            device?.name
          );
        }
        // Reset parser state on disconnect
        resetBleParser();
      }
    );

    // Dump all services & chars for debugging
    await logServicesAndCharacteristics(connected);

    console.log(
      "[BLE] starting notifications on service =",
      SERVICE_UUID,
      " char =",
      CHAR_UUID
    );

    const subscription: Subscription =
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
            // value is base64 → convert to bytes → ArrayBuffer
            const buf = Buffer.from(characteristic.value, "base64");
            const bytes = new Uint8Array(buf);
            const parsed = parseBleNotificationPacket(bytes.buffer, eventId);
            if (parsed) {
              detections.push(parsed);
              console.log("[BLE] parsed detection:", parsed);
            } else {
              console.log("[BLE] parseBleNotificationPacket returned null");
            }
          } catch (e) {
            console.error("[BLE] parse error:", e);
          }
        }
      );

    console.log("[BLE] collecting notifications for", windowMs, "ms…");
    await new Promise((resolve) => setTimeout(resolve, windowMs));

    console.log("[BLE] done collecting notifications (we're not force-disconnecting here now).");
    // We leave the device connection to firmware / OS timing for now.

  } catch (e) {
    console.error("[BLE] collectDetectionsFromEsp32 FAILED:", e);
    throw e;
  }

  return detections;
}

/**
 * INTERNAL: scan until we find a device with the given name or MAC (timeout after 10s).
 */
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