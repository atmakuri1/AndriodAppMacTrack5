// app/app/(tabs)/detections.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Platform,
  TextInput,
  Pressable,
  ScrollView,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import {
  DetectionRow,
  getDetections,
  createDetectionsBatch,
} from "../../api";
import {
  collectDetectionsFromEsp32,
  scanForNearbyDevices,
  SimpleBleDevice,
} from "../../bleClient";
import * as SecureStore from "expo-secure-store";

// emulator helper – keep OFF on real device
const DEV_FAKE_DEVICES = false;

export default function DetectionsScreen() {
  const { event_id: initialEventId } =
    useLocalSearchParams<{ event_id?: string }>();

  const [rows, setRows] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  // text in the "Select Event" box
  const [eventFilterInput, setEventFilterInput] = useState(
    initialEventId ?? ""
  );
  // actually-applied filter
  const [activeEventId, setActiveEventId] = useState<string | undefined>(
    (initialEventId as string | undefined) || undefined
  );

  const [refreshing, setRefreshing] = useState(false);

  // BLE device selection state
  const [scanningDevices, setScanningDevices] = useState(false);
  const [devices, setDevices] = useState<SimpleBleDevice[]>(
    DEV_FAKE_DEVICES
      ? [
          { id: "FAKE-ESP32-1", name: "BluStick ESP32 A" },
          { id: "FAKE-ESP32-2", name: "BluStick ESP32 B" },
        ]
      : []
  );
  const [deviceScanError, setDeviceScanError] = useState("");
  const [syncing, setSyncing] = useState(false);

  const loadDetections = async (eventId?: string) => {
    try {
      setErr("");
      if (!refreshing) setLoading(true);

      const data = await getDetections({
        event_id: eventId || undefined,
        limit: 200,
      });

      setRows(data);
    } catch (e: any) {
      setErr(e?.message || "Failed to load detections");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // initial load
  useEffect(() => {
    loadDetections(activeEventId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = () => {
    const trimmed = eventFilterInput.trim();
    const next = trimmed.length ? trimmed : undefined;
    setActiveEventId(next);
    loadDetections(next);
  };

  const refresh = () => {
    setRefreshing(true);
    loadDetections(activeEventId);
  };

  const clearFilter = () => {
    setEventFilterInput("");
    setActiveEventId(undefined);
    loadDetections(undefined);
  };

  /**
   * 1) User taps "Sync from device"
   *    => we scan for nearby BLE devices and show them in a list.
   */
  const startDeviceScan = async () => {
    try {
      setDeviceScanError("");
      setScanningDevices(true);

      if (DEV_FAKE_DEVICES) {
        console.log("DEV: fake scan for devices");
        // keep the pre-filled devices so the UI always shows in emulator
        await new Promise((resolve) => setTimeout(resolve, 800));
        return;
      }

      setDevices([]);

      // 👉 REAL BLE path (works only on physical device)
      const list = await scanForNearbyDevices(8000);
      setDevices(list);

      if (list.length === 0) {
        setDeviceScanError("No BLE devices found nearby.");
      }
    } catch (e: any) {
      console.warn(e);
      setDeviceScanError(e?.message || "Failed to scan for devices");
    } finally {
      setScanningDevices(false);
    }
  };

  /**
   * 2) User taps one specific device from the list -> sync from that device.
   *    Now uploads directly to backend without showing raw data.
   */
  const syncFromSelectedDevice = async (deviceId: string) => {
    try {
      if (DEV_FAKE_DEVICES) {
        console.log("DEV: pretend syncing from", deviceId);
        Alert.alert("Success", "1 detection uploaded (dev mode)");
        return;
      }

      setSyncing(true);
      setErr("");

      // Get JWT token for authentication
      const token = await SecureStore.getItemAsync("jwt");
      if (!token) {
        console.warn("[UI] no JWT token, cannot upload detections");
        Alert.alert("Error", "Not authenticated. Please log in.");
        return;
      }

      console.log("[UI] Collecting detections from device:", deviceId);
      
      // 1) Collect detections from ESP32
      const batch = await collectDetectionsFromEsp32(
        activeEventId ?? null,
        30000, // 30 seconds collection window
        { deviceId }
      );

      console.log("[UI] Collected", batch.length, "detections");

      if (!batch.length) {
        Alert.alert("Info", "No detections received from device.");
        return;
      }

      // 2) Upload directly to backend (no local state)
      console.log("[UI] Uploading detections to backend...");
      await createDetectionsBatch(batch);
      
      console.log("[UI] Upload successful!");
      Alert.alert(
        "Success",
        `${batch.length} detection${batch.length === 1 ? "" : "s"} uploaded to backend`
      );

      // 3) Refresh the list to show newly uploaded detections
      await loadDetections(activeEventId);

      // ✅ after a successful sync, hide the device list to "collapse" that area
      setDevices([]);
    } catch (e: any) {
      console.error("[UI] Sync/upload failed:", e);
      Alert.alert(
        "Error",
        e?.message || "Failed to sync from device and upload to backend"
      );
    } finally {
      setSyncing(false);
    }
  };

  const mono = Platform.select({ ios: "Menlo", android: "monospace" }) as any;

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerLine} />
      <View style={s.content}>
        {/* tiny dev badge so you know you're in fake mode */}
        {DEV_FAKE_DEVICES && (
          <View style={s.devBadge}>
            <Text style={s.devBadgeText}>DEV BLE FAKE MODE</Text>
          </View>
        )}

        {/* Filter controls */}
        <View style={s.filterContainer}>
          <Text style={s.filterSectionLabel}>Event Filter</Text>
          <View style={s.filterInputRow}>
            <TextInput
              style={s.filterInput}
              value={eventFilterInput}
              onChangeText={setEventFilterInput}
              placeholder="Enter event ID (optional)"
              placeholderTextColor="#9aa4b2"
            />
            <Pressable onPress={applyFilter} style={s.filterButton}>
              <Text style={s.filterButtonText}>Apply</Text>
            </Pressable>
          </View>

          <View style={s.actionRow}>
            {activeEventId && (
              <Pressable onPress={clearFilter} style={s.clearBtn}>
                <Text style={s.clearText}>✕ Clear</Text>
              </Pressable>
            )}

            <Pressable
              onPress={startDeviceScan}
              disabled={scanningDevices || syncing}
              style={[
                s.syncBtn,
                (scanningDevices || syncing) && { opacity: 0.6 },
              ]}
            >
              <Text style={s.syncText}>
                {scanningDevices
                  ? "Scanning…"
                  : syncing
                  ? "Syncing…"
                  : "Sync from device"}
              </Text>
            </Pressable>

            <Pressable
              onPress={refresh}
              disabled={refreshing}
              style={[s.refreshBtn, refreshing && { opacity: 0.6 }]}
            >
              <Text style={s.refreshText}>
                {refreshing ? "↻ Refreshing..." : "↻ Refresh"}
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Device picker area */}
        <View style={s.deviceSection}>
          <Text style={s.deviceTitle}>Nearby devices</Text>

          {scanningDevices ? (
            <View style={s.centerRow}>
              <ActivityIndicator size="small" color="#5cd6ff" />
              <Text style={[s.deviceInfoText, { marginLeft: 8 }]}>
                Scanning…
              </Text>
            </View>
          ) : deviceScanError ? (
            <Text style={s.deviceError}>{deviceScanError}</Text>
          ) : devices.length === 0 ? (
            <Text style={s.deviceInfoText}>
              Tap &quot;Sync from device&quot; to scan for ESP32 units.
            </Text>
          ) : (
            // ✅ Scrollable device list with max height so it doesn't take over the screen
            <ScrollView style={s.deviceList} nestedScrollEnabled>
              {devices.map((d) => (
                <Pressable
                  key={d.id}
                  style={s.deviceItem}
                  onPress={() => syncFromSelectedDevice(d.id)}
                  disabled={syncing}
                >
                  <View>
                    <Text style={s.deviceName}>{d.name ?? "(unnamed)"}</Text>
                    <Text style={s.deviceId}>{d.id}</Text>
                  </View>
                  <Text style={s.deviceSyncLabel}>
                    {syncing ? "…" : "Sync"}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>

        {/* Status indicator */}
        <View style={s.statusBar}>
          <Text style={s.statusText}>
            {activeEventId ? (
              <>
                Filtering:{" "}
                <Text style={s.statusHighlight}>{activeEventId}</Text>
              </>
            ) : (
              "Showing all events"
            )}
          </Text>
          <Text style={s.countText}>{rows.length} detections</Text>
        </View>

        {/* Body */}
        {loading ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#5cd6ff" />
          </View>
        ) : err ? (
          <View style={s.center}>
            <Text style={s.err}>{err}</Text>
          </View>
        ) : rows.length === 0 ? (
          <View style={s.center}>
            <Text style={s.empty}>No detections found</Text>
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(i, idx) =>
              i.blustick_id ?? `${i.mac_address}-${i.detected_at}-${idx}`
            }
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            renderItem={({ item }) => (
              <View style={s.card}>
                <View style={s.cardHeader}>
                  <Text style={[s.mac, { fontFamily: mono }]}>
                    {item.mac_address ?? "(unknown)"}
                  </Text>
                  {item.signal_type && (
                    <View style={s.badge}>
                      <Text style={s.badgeText}>{item.signal_type}</Text>
                    </View>
                  )}
                </View>

                <View style={s.detailsGrid}>
                  <View style={s.detailItem}>
                    <Text style={s.detailLabel}>RSSI</Text>
                    <Text style={s.detailValue}>
                      {item.rssi ?? "—"} dBm
                    </Text>
                  </View>
                  <View style={s.detailItem}>
                    <Text style={s.detailLabel}>Distance</Text>
                    <Text style={s.detailValue}>
                      {item.estimated_distance != null
                        ? `${item.estimated_distance.toFixed(2)} m`
                        : "—"}
                    </Text>
                  </View>
                </View>

                <View style={s.detailsGrid}>
                  <View style={s.detailItem}>
                    <Text style={s.detailLabel}>Latitude</Text>
                    <Text style={s.detailValue}>{item.latitude ?? "—"}</Text>
                  </View>
                  <View style={s.detailItem}>
                    <Text style={s.detailLabel}>Longitude</Text>
                    <Text style={s.detailValue}>{item.longitude ?? "—"}</Text>
                  </View>
                </View>

                <Text style={s.time}>
                  {new Date(item.detected_at).toLocaleString()}
                </Text>
              </View>
            )}
            contentContainerStyle={{ paddingBottom: 24 }}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  headerLine: { height: 1, backgroundColor: "rgba(92,214,255,0.12)" },
  content: { flex: 1, padding: 16 },

  devBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(255,215,0,0.1)",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(255,215,0,0.4)",
    marginBottom: 8,
  },
  devBadgeText: {
    color: "#ffd700",
    fontSize: 11,
    fontWeight: "700",
  },

  filterContainer: {
    marginBottom: 12,
  },

  filterSectionLabel: {
    color: "#9aa4b2",
    fontSize: 11,
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  filterInputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f1a2a",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
    borderRadius: 10,
    paddingLeft: 12,
    marginBottom: 8,
    height: 48,
  },

  filterInput: {
    flex: 1,
    color: "#e6edf5",
    fontSize: 14,
    height: "100%",
  },

  filterButton: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    backgroundColor: "#23b8f0",
    borderTopRightRadius: 9,
    borderBottomRightRadius: 9,
    justifyContent: "center",
    alignItems: "center",
    height: "100%",
  },

  filterButtonText: {
    color: "#0b1420",
    fontWeight: "700",
    fontSize: 14,
  },

  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    marginTop: 6,
    gap: 8,
  },

  clearBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(255,107,107,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,107,107,0.3)",
  },

  clearText: {
    color: "#ff6b6b",
    fontSize: 13,
    fontWeight: "600",
  },

  syncBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "#23b8f0",
  },

  syncText: {
    color: "#0b1420",
    fontSize: 13,
    fontWeight: "700",
  },

  refreshBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.4)",
    backgroundColor: "rgba(35,184,240,0.08)",
  },

  refreshText: {
    color: "#5cd6ff",
    fontSize: 13,
    fontWeight: "600",
  },

  deviceSection: {
    marginBottom: 12,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "rgba(10,18,32,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.18)",
  },

  deviceTitle: {
    color: "#c9d5e3",
    fontSize: 13,
    fontWeight: "600",
    marginBottom: 6,
  },

  deviceInfoText: {
    color: "#9aa4b2",
    fontSize: 12,
  },

  deviceError: {
    color: "#ff6b6b",
    fontSize: 12,
  },

  // ✅ scrollable area with maxHeight
  deviceList: {
    marginTop: 6,
    maxHeight: 200,
  },

  deviceItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
    marginBottom: 6,
  },

  deviceName: {
    color: "#e6edf5",
    fontSize: 13,
    fontWeight: "600",
  },

  deviceId: {
    color: "#7f8a99",
    fontSize: 11,
  },

  deviceSyncLabel: {
    color: "#5cd6ff",
    fontWeight: "700",
    fontSize: 13,
  },

  centerRow: {
    flexDirection: "row",
    alignItems: "center",
  },

  statusBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(18,28,44,0.6)",
    borderRadius: 8,
    marginBottom: 12,
  },

  statusText: {
    color: "#9aa4b2",
    fontSize: 12,
  },

  statusHighlight: {
    color: "#5cd6ff",
    fontWeight: "600",
  },

  countText: {
    color: "#c9d5e3",
    fontSize: 12,
    fontWeight: "600",
  },

  center: { paddingVertical: 24, alignItems: "center" },
  err: { color: "#ff6b6b" },
  empty: { color: "#9aa4b2" },

  card: {
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.18)",
    borderRadius: 10,
    padding: 12,
  },

  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },

  mac: {
    color: "#e6edf5",
    fontWeight: "700",
    fontSize: 14,
  },

  badge: {
    backgroundColor: "rgba(35,184,240,0.15)",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.3)",
  },

  badgeText: {
    color: "#5cd6ff",
    fontSize: 11,
    fontWeight: "700",
  },

  detailsGrid: {
    flexDirection: "row",
    marginBottom: 8,
  },

  detailItem: {
    flex: 1,
  },

  detailLabel: {
    color: "#7f8a99",
    fontSize: 10,
    marginBottom: 3,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  detailValue: {
    color: "#c9d5e3",
    fontSize: 14,
    fontWeight: "600",
  },

  time: {
    color: "#7f8a99",
    marginTop: 4,
    fontSize: 11,
    fontStyle: "italic",
  },
});