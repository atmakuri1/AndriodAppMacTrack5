// app/(tabs)/detections.tsx - Simplified version
import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Platform,
  TextInput,
  Pressable,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { DetectionRow, getDetections, createDetectionsBatch } from "../../api";
import {
  collectDetectionsFromEsp32,
  scanForNearbyDevices,
  SimpleBleDevice,
} from "../../bleClient";
import * as SecureStore from "expo-secure-store";
import { PermissionsAndroid } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const DEV_FAKE_DEVICES = false;
const TEST_LIMIT = 20;

// Reusable Components
const SignalBars = ({ rssi }: { rssi: number | null }) => {
  if (!rssi) return <Text style={s.value}>—</Text>;
  const strength = Math.min(4, Math.max(1, Math.floor((rssi + 100) / 15)));
  
  return (
    <View style={s.signalBars}>
      {[1, 2, 3, 4].map((bar) => (
        <View
          key={bar}
          style={[
            s.bar,
            { height: bar * 4 + 4, backgroundColor: bar <= strength ? "#5cd6ff" : "#2a3b4c" }
          ]}
        />
      ))}
      <Text style={s.signalText}>{rssi} dBm</Text>
    </View>
  );
};

const SkeletonCard = () => (
  <View style={[s.card, s.skeleton]}>
    <View style={[s.skeletonLine, { width: "60%" }]} />
    <View style={[s.skeletonLine, { width: "40%" }]} />
    <View style={[s.skeletonLine, { width: "80%" }]} />
  </View>
);

const IconButton = ({ name, onPress, disabled, color = "#5cd6ff", bg }: any) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    style={[s.iconBtn, bg && { backgroundColor: bg }, disabled && s.disabled]}
  >
    <Ionicons name={name} size={16} color={color} />
  </Pressable>
);

export default function DetectionsScreen() {
  const router = useRouter();
  const { event_id: initialEventId, mac: macFromParams } = useLocalSearchParams<{
    event_id?: string;
    mac?: string;
  }>();

  // State
  const [rows, setRows] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [eventInput, setEventInput] = useState(initialEventId ?? "");
  const [activeEventId, setActiveEventId] = useState<string | undefined>(initialEventId as string);
  const [activeMac, setActiveMac] = useState<string | undefined>(macFromParams as string);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<SimpleBleDevice[]>(
    DEV_FAKE_DEVICES ? [{ id: "FAKE-1", name: "BluStick A" }] : []
  );
  const [deviceError, setDeviceError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");

  // Load detections
  const loadDetections = async (eventId?: string, mac?: string) => {
    try {
      setErr("");
      if (!refreshing) setLoading(true);

      const data = await getDetections({
        event_id: eventId,
        mac_address: mac,
        limit: 200,
      });

      setRows(data);
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Effects
  useEffect(() => {
    loadDetections(activeEventId, activeMac);
  }, []);

  useEffect(() => {
    if (macFromParams && macFromParams !== activeMac) {
      setActiveMac(macFromParams as string);
      loadDetections(activeEventId, macFromParams as string);
    }
  }, [macFromParams]);

  // Actions
  const applyFilter = () => {
    const trimmed = eventInput.trim();
    const next = trimmed || undefined;
    setActiveEventId(next);
    loadDetections(next, activeMac);
  };

  const clearFilter = () => {
    setEventInput("");
    setActiveEventId(undefined);
    setActiveMac(undefined);
    loadDetections();
  };

  const viewOnMap = () => {
    if (!activeMac) {
      Alert.alert("No Device", "Select a MAC address first");
      return;
    }
    router.push({ pathname: "/(tabs)/map" as any, params: { mac: activeMac } });
  };

  const startScan = async () => {
    try {
      setDeviceError("");
      setScanning(true);

      if (Platform.OS === "android" && Platform.Version >= 31) {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        if (!Object.values(granted).every((v) => v === "granted")) {
          setDeviceError("Permissions denied");
          return;
        }
      }

      if (DEV_FAKE_DEVICES) {
        await new Promise((r) => setTimeout(r, 800));
        return;
      }

      const list = await scanForNearbyDevices(8000);
      setDevices(list);
      if (!list.length) setDeviceError("No devices found");
    } catch (e: any) {
      setDeviceError(e?.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  const syncDevice = async (deviceId: string) => {
    try {
      if (DEV_FAKE_DEVICES) {
        Alert.alert("Success", "Dev mode sync");
        return;
      }

      setSyncing(true);
      setSyncStatus("Connecting...");

      const token = await SecureStore.getItemAsync("token");
      if (!token) {
        Alert.alert("Error", "Not authenticated");
        return;
      }

      setSyncStatus("Collecting...");
      const batch = await collectDetectionsFromEsp32(activeEventId ?? null, 30000, { deviceId });

      if (!batch.length) {
        Alert.alert("Info", "No detections");
        setDevices([]);
        return;
      }

      const limited = batch.slice(0, TEST_LIMIT);
      setSyncStatus(`Uploading ${limited.length}...`);

      await createDetectionsBatch(limited);
      
      const msg = batch.length > TEST_LIMIT
        ? `TEST: Uploaded ${limited.length}/${batch.length}`
        : `${limited.length} uploaded!`;
      
      Alert.alert("Success", msg);
      await loadDetections(activeEventId, activeMac);
      setDevices([]);
    } catch (e: any) {
      const msg = e?.message?.includes("401") ? "Auth error" :
                  e?.message?.includes("Network") ? "Network error" :
                  e?.message || "Sync failed";
      Alert.alert("Sync Failed", msg);
      setErr(msg);
    } finally {
      setSyncing(false);
      setSyncStatus("");
    }
  };

  // Render helpers
  const renderDetection = useCallback(({ item }: { item: DetectionRow }) => (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={[s.mac, { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) }]}>
          {item.mac_address ?? "unknown"}
        </Text>
        {item.signal_type && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{item.signal_type}</Text>
          </View>
        )}
      </View>

      <View style={s.grid}>
        <View style={s.gridItem}>
          <Text style={s.label}>SIGNAL</Text>
          <SignalBars rssi={item.rssi} />
        </View>
        <View style={s.gridItem}>
          <Text style={s.label}>DISTANCE</Text>
          <Text style={s.value}>
            {item.estimated_distance ? `${item.estimated_distance.toFixed(2)} m` : "—"}
          </Text>
        </View>
      </View>

      <View style={s.grid}>
        <View style={s.gridItem}>
          <Text style={s.label}>LAT</Text>
          <Text style={s.value}>{item.latitude?.toFixed(6) ?? "—"}</Text>
        </View>
        <View style={s.gridItem}>
          <Text style={s.label}>LNG</Text>
          <Text style={s.value}>{item.longitude?.toFixed(6) ?? "—"}</Text>
        </View>
      </View>

      <View style={s.timeRow}>
        <Ionicons name="time-outline" size={12} color="#7f8a99" />
        <Text style={s.time}>{new Date(item.detected_at).toLocaleString()}</Text>
      </View>
    </View>
  ), []);

  const keyExtractor = useCallback(
    (item: DetectionRow, idx: number) =>
      `${item.blustick_id}-${item.mac_address}-${item.detected_at}-${idx}`,
    []
  );

  return (
    <SafeAreaView style={s.root}>
      <View style={s.divider} />
      
      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderDetection}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={s.content}
        removeClippedSubviews
        maxToRenderPerBatch={10}
        initialNumToRender={10}
        windowSize={10}
        ListHeaderComponent={
          <>
            {/* Filter */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>EVENT FILTER</Text>
              <View style={s.inputRow}>
                <TextInput
                  style={s.input}
                  value={eventInput}
                  onChangeText={setEventInput}
                  placeholder="Event ID (optional)"
                  placeholderTextColor="#9aa4b2"
                />
                <Pressable onPress={applyFilter} style={s.applyBtn}>
                  <Text style={s.applyText}>Apply</Text>
                </Pressable>
              </View>

              {/* Actions */}
              <View style={s.actions}>
                <Pressable
                  onPress={startScan}
                  disabled={scanning || syncing}
                  style={[s.syncBtn, (scanning || syncing) && s.disabled]}
                >
                  <Ionicons name="bluetooth" size={16} color="#0b1420" />
                  <Text style={s.syncText}>{scanning ? "Scanning" : "Sync"}</Text>
                </Pressable>

                <IconButton name="refresh" onPress={() => { setRefreshing(true); loadDetections(activeEventId, activeMac); }} disabled={refreshing} />
                {activeMac && <IconButton name="map" onPress={viewOnMap} />}
                {(activeEventId || activeMac) && <IconButton name="close" onPress={clearFilter} color="#ff6b6b" />}
              </View>
            </View>

            {/* Sync Status */}
            {syncStatus && (
              <View style={s.statusBar}>
                <ActivityIndicator size="small" color="#5cd6ff" />
                <Text style={s.statusText}>{syncStatus}</Text>
              </View>
            )}

            {/* Devices */}
            <View style={s.section}>
              <View style={s.row}>
                <Ionicons name="hardware-chip-outline" size={18} color="#5cd6ff" />
                <Text style={s.sectionTitle}>Nearby Devices</Text>
              </View>

              {scanning ? (
                <View style={s.center}>
                  <ActivityIndicator size="small" color="#5cd6ff" />
                  <Text style={s.info}>Scanning...</Text>
                </View>
              ) : deviceError ? (
                <View style={s.errorBox}>
                  <Ionicons name="alert-circle-outline" size={20} color="#ff6b6b" />
                  <Text style={s.errorText}>{deviceError}</Text>
                </View>
              ) : !devices.length ? (
                <View style={s.empty}>
                  <Ionicons name="bluetooth-outline" size={32} color="#3a4b5c" />
                  <Text style={s.info}>Tap "Sync" to scan</Text>
                </View>
              ) : (
                devices.map((d) => (
                  <Pressable
                    key={d.id}
                    style={s.device}
                    onPress={() => syncDevice(d.id)}
                    disabled={syncing}
                  >
                    <View style={s.deviceIcon}>
                      <Ionicons name="hardware-chip" size={24} color="#5cd6ff" />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.deviceName}>{d.name ?? "unnamed"}</Text>
                      <Text style={s.deviceId}>{d.id}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={20} color="#9aa4b2" />
                  </Pressable>
                ))
              )}
            </View>

            {/* Status */}
            <View style={s.status}>
              <View style={s.row}>
                <Ionicons name={activeMac ? "filter" : "list"} size={14} color="#9aa4b2" />
                <Text style={s.statusLabel}>
                  {activeMac ? (
                    <Text style={s.highlight}>{activeMac}</Text>
                  ) : activeEventId ? (
                    <Text style={s.highlight}>{activeEventId}</Text>
                  ) : (
                    "All detections"
                  )}
                </Text>
              </View>
              <View style={s.count}>
                <Text style={s.countText}>{rows.length}</Text>
              </View>
            </View>
          </>
        }
        ListEmptyComponent={
          loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : err ? (
            <View style={s.center}>
              <Ionicons name="alert-circle-outline" size={48} color="#ff6b6b" />
              <Text style={s.errorText}>{err}</Text>
              <Pressable onPress={() => loadDetections(activeEventId, activeMac)} style={s.retryBtn}>
                <Text style={s.retryText}>Try Again</Text>
              </Pressable>
            </View>
          ) : (
            <View style={s.center}>
              <Ionicons name="radio-outline" size={64} color="#3a4b5c" />
              <Text style={s.emptyTitle}>No Detections</Text>
              <Text style={s.info}>Sync your device to start</Text>
              <Pressable onPress={startScan} style={s.syncBtn}>
                <Text style={s.syncText}>Scan Devices</Text>
              </Pressable>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  divider: { height: 1, backgroundColor: "rgba(92,214,255,0.12)" },
  content: { padding: 16 },
  
  section: { marginBottom: 12, padding: 12, borderRadius: 10, backgroundColor: "rgba(10,18,32,0.9)", borderWidth: 1, borderColor: "rgba(92,214,255,0.18)" },
  sectionLabel: { color: "#9aa4b2", fontSize: 11, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  sectionTitle: { color: "#c9d5e3", fontSize: 13, fontWeight: "600" },
  
  inputRow: { flexDirection: "row", backgroundColor: "#0f1a2a", borderWidth: 1, borderColor: "rgba(92,214,255,0.25)", borderRadius: 10, height: 48, marginBottom: 8 },
  input: { flex: 1, color: "#e6edf5", fontSize: 14, paddingLeft: 12 },
  applyBtn: { paddingHorizontal: 20, backgroundColor: "#23b8f0", borderTopRightRadius: 9, borderBottomRightRadius: 9, justifyContent: "center" },
  applyText: { color: "#0b1420", fontWeight: "700", fontSize: 14 },
  
  actions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  syncBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: "#23b8f0" },
  syncText: { color: "#0b1420", fontSize: 13, fontWeight: "700" },
  iconBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: "rgba(92,214,255,0.4)", backgroundColor: "rgba(35,184,240,0.08)" },
  disabled: { opacity: 0.6 },
  
  statusBar: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: "rgba(92,214,255,0.1)", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, marginBottom: 12, borderWidth: 1, borderColor: "rgba(92,214,255,0.25)" },
  statusText: { color: "#5cd6ff", fontSize: 13, fontWeight: "600" },
  
  device: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 8, backgroundColor: "rgba(18,28,44,0.9)", borderWidth: 1, borderColor: "rgba(92,214,255,0.25)", marginTop: 8, gap: 12 },
  deviceIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(92,214,255,0.1)", alignItems: "center", justifyContent: "center" },
  deviceName: { color: "#e6edf5", fontSize: 14, fontWeight: "600" },
  deviceId: { color: "#7f8a99", fontSize: 11 },
  
  status: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, backgroundColor: "rgba(18,28,44,0.6)", borderRadius: 8, marginBottom: 12 },
  statusLabel: { color: "#9aa4b2", fontSize: 12, flex: 1 },
  highlight: { color: "#5cd6ff", fontWeight: "600" },
  count: { backgroundColor: "rgba(92,214,255,0.15)", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)" },
  countText: { color: "#5cd6ff", fontSize: 12, fontWeight: "700" },
  
  card: { backgroundColor: "rgba(18,28,44,0.9)", borderWidth: 1, borderColor: "rgba(92,214,255,0.18)", borderRadius: 10, padding: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  mac: { color: "#e6edf5", fontWeight: "700", fontSize: 14 },
  badge: { backgroundColor: "rgba(35,184,240,0.15)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)" },
  badgeText: { color: "#5cd6ff", fontSize: 11, fontWeight: "700" },
  
  grid: { flexDirection: "row", marginBottom: 10, gap: 12 },
  gridItem: { flex: 1 },
  label: { color: "#7f8a99", fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  value: { color: "#c9d5e3", fontSize: 14, fontWeight: "600" },
  
  signalBars: { flexDirection: "row", alignItems: "center", gap: 8 },
  bar: { width: 3, borderRadius: 1.5 },
  signalText: { color: "#c9d5e3", fontSize: 12, fontWeight: "600" },
  
  timeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  time: { color: "#7f8a99", fontSize: 11, fontStyle: "italic" },
  
  skeleton: { opacity: 0.5 },
  skeletonLine: { height: 12, backgroundColor: "rgba(92,214,255,0.1)", borderRadius: 4, marginBottom: 8 },
  
  center: { alignItems: "center", paddingVertical: 40, gap: 12 },
  empty: { alignItems: "center", paddingVertical: 16, gap: 8 },
  info: { color: "#9aa4b2", fontSize: 12 },
  errorBox: { flexDirection: "row", alignItems: "center", gap: 8, padding: 10, backgroundColor: "rgba(255,107,107,0.1)", borderRadius: 8 },
  errorText: { color: "#ff6b6b", fontSize: 12, flex: 1 },
  retryBtn: { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "rgba(92,214,255,0.1)", borderRadius: 8, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)" },
  retryText: { color: "#5cd6ff", fontWeight: "600", fontSize: 14 },
  emptyTitle: { color: "#e6edf5", fontSize: 18, fontWeight: "700", marginTop: 8 },
});