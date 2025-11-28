// app/bleParsing.ts
import { Buffer } from "buffer";
import { NewDetectionInput } from "./api";

// Track an approximate boot time (epoch ms) for the current connection
let bootEpochMs: number | null = null;

// Throttle logging - only log every Nth packet
let packetCount = 0;
const LOG_EVERY_N_PACKETS = 10;

export function parseBleNotificationPacket(
  buf: ArrayBuffer,
  eventId: string | null
): NewDetectionInput | null {
  const bytes = new Uint8Array(buf);
  
  packetCount++;
  const shouldLog = packetCount % LOG_EVERY_N_PACKETS === 0;
  
  if (shouldLog) {
    console.log(`[BLE] Processed ${packetCount} packets (${bytes.length} bytes)`);
  }

  // --- CASE 1: struct packet (80 bytes) ---
  if (bytes.length === 80) {
    try {
      const view = new DataView(buf);

      // mac_addr[30] - extract null-terminated string from first 30 bytes
      const macBytes = bytes.slice(0, 30);
      let macStr = "";
      for (let i = 0; i < macBytes.length; i++) {
        if (macBytes[i] === 0) break; // stop at first null
        macStr += String.fromCharCode(macBytes[i]);
      }
      macStr = macStr.trim();

      const macMatch = macStr.match(/[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}/);
      const mac = (macMatch ? macMatch[0] : macStr).toUpperCase();

      // int8_t curr_rssi, rssi (offset 30, 31)
      const currRssi = view.getInt8(30);
      const avgRssi = view.getInt8(31);

      // Decide which RSSI to use in the final detection
      let selectedRssi: number | null = null;

      // Treat 0 as "no avg yet"
      const isValidRssi = (v: number) => v <= 0 && v >= -127;

      // Prefer avg if it looks valid; otherwise fall back to curr
      if (isValidRssi(avgRssi)) {
        selectedRssi = avgRssi;
      } else if (isValidRssi(currRssi)) {
        selectedRssi = currRssi;
      } else {
        selectedRssi = null; // weird / corrupt case
      }

      // uint32_t timestamp (offset 32, little-endian)
      const rawTimestamp = view.getUint32(32, true);

      // float distance (offset 36, little-endian)
      const distance = view.getFloat32(36, true);

      // uuid_str[40] (offset 40-79) - extract null-terminated string
      const uuidBytes = bytes.slice(40, 80);
      let uuidStr = "";
      for (let i = 0; i < uuidBytes.length; i++) {
        if (uuidBytes[i] === 0) break; // stop at first null
        uuidStr += String.fromCharCode(uuidBytes[i]);
      }
      uuidStr = uuidStr.trim();

      // Initialize approximate boot time on first packet
      if (bootEpochMs == null) {
        bootEpochMs = Date.now() - rawTimestamp * 1000;
      }

      const detectedAt = new Date(bootEpochMs + rawTimestamp * 1000).toISOString();

      if (shouldLog) {
        console.log(`[BLE] ✓ ${mac} | RSSI: ${selectedRssi} | Dist: ${distance.toFixed(1)}m`);
      }

      const detection: NewDetectionInput = {
        event_id: eventId,
        mac_address: mac,
        signal_type: "BLE",
        rssi: selectedRssi,
        estimated_distance:
          Number.isFinite(distance) && distance > 0 ? distance : null,
        latitude: null,
        longitude: null,
        detected_at: detectedAt,
      };

      return detection;
    } catch (e) {
      console.warn("[BLE] error parsing struct packet:", e);
      return null;
    }
  }

  // --- CASE 2: fallback 20-byte ASCII MAC packets ---
  if (bytes.length >= 10 && bytes.length < 80) {
    const asciiRaw = Buffer.from(bytes).toString("ascii");
    const ascii = asciiRaw.split("\0")[0].trim();

    const match = ascii.match(/[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}/);
    if (!match) {
      return null;
    }

    const mac = match[0].toUpperCase();
    
    if (shouldLog) {
      console.log(`[BLE] ✓ ${mac} (fallback)`);
    }

    const detection: NewDetectionInput = {
      event_id: eventId,
      mac_address: mac,
      signal_type: "BLE",
      rssi: null,
      estimated_distance: null,
      latitude: null,
      longitude: null,
      detected_at: new Date().toISOString(),
    };

    return detection;
  }

  return null;
}

// Call this when disconnecting to reset state
export function resetBleParser() {
  bootEpochMs = null;
  packetCount = 0;
}