// app/bleParsing.ts
import { Buffer } from "buffer";
import { NewDetectionInput } from "./api";

// Track an approximate boot time (epoch ms) for the current connection
let bootEpochMs: number | null = null;

export function parseBleNotificationPacket(
  buf: ArrayBuffer,
  eventId: string | null
): NewDetectionInput | null {
  const bytes = new Uint8Array(buf);
  console.log("BLE parse: packet len =", bytes.length);

  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  console.log("BLE parse: hex =", hex);

  // --- CASE 1: struct packet (80 bytes) ---
  if (bytes.length === 80) {
    console.log("*** DETECTED 80-BYTE STRUCT PACKET ***");
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
      console.log("Parsed MAC string:", macStr);

      const macMatch = macStr.match(/[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}/);
      const mac = (macMatch ? macMatch[0] : macStr).toUpperCase();

      // int8_t curr_rssi, rssi (offset 30, 31)
      const currRssi = view.getInt8(30);
      const avgRssi = view.getInt8(31);
      console.log("Parsed RSSI values - curr:", currRssi, "avg:", avgRssi);

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

      console.log("Selected RSSI:", selectedRssi);

      // uint32_t timestamp (offset 32, little-endian)
      const rawTimestamp = view.getUint32(32, true);
      console.log("Parsed timestamp:", rawTimestamp);

      // float distance (offset 36, little-endian)
      const distance = view.getFloat32(36, true);
      console.log("Parsed distance:", distance);

      // uuid_str[40] (offset 40-79) - extract null-terminated string
      const uuidBytes = bytes.slice(40, 80);
      let uuidStr = "";
      for (let i = 0; i < uuidBytes.length; i++) {
        if (uuidBytes[i] === 0) break; // stop at first null
        uuidStr += String.fromCharCode(uuidBytes[i]);
      }
      uuidStr = uuidStr.trim();
      console.log("Parsed UUID string:", uuidStr);

      // Initialize approximate boot time on first packet
      if (bootEpochMs == null) {
        bootEpochMs = Date.now() - rawTimestamp * 1000;
        console.log("[BLE] estimated bootEpochMs =", new Date(bootEpochMs).toISOString());
      }

      const detectedAt = new Date(bootEpochMs + rawTimestamp * 1000).toISOString();

      console.log("BLE struct parsed:", {
        mac,
        currRssi,
        avgRssi,
        selectedRssi,
        rawTimestamp,
        distance,
        uuidStr,
        detectedAt,
      });

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
    console.log("*** Using fallback 20-byte MAC parsing ***");
    const asciiRaw = Buffer.from(bytes).toString("ascii");
    const ascii = asciiRaw.split("\0")[0].trim();
    console.log("BLE parse (fallback ASCII):", JSON.stringify(ascii));

    const match = ascii.match(/[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}/);
    if (!match) {
      console.log("parseBleNotificationPacket: no MAC found in fallback packet");
      return null;
    }

    const mac = match[0].toUpperCase();

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

    console.log("parseBleNotificationPacket: fallback detection", detection);
    return detection;
  }

  console.log("parseBleNotificationPacket: unknown packet size, ignoring");
  return null;
}

// Call this when disconnecting to reset state
export function resetBleParser() {
  bootEpochMs = null;
  console.log("BLE parser state reset");
}