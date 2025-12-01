// app/(tabs)/detections.tsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View, Text, FlatList, ActivityIndicator, Pressable, StyleSheet,
  Alert, Platform, PermissionsAndroid
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as SecureStore from "expo-secure-store";

import {
  DetectionRow, getDetections, createDetectionsBatch
} from "../../api";
import {
  scanForNearbyDevices, collectDetectionsLive, stopLiveStream,
  SimpleBleDevice
} from "../../bleClient";

const Mono = Platform.select({ ios: "Menlo", android: "monospace" });

// ---------- UTILITIES ----------
const U = {
  mac: (m?: string) => (m && m.length > 11 ? `${m.slice(0, 8)}…${m.slice(-5)}` : m ?? "—"),
  time: (t: string) =>
    new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  bars: (r?: number | null) => (!r ? 0 : r >= -50 ? 4 : r >= -60 ? 3 : r >= -70 ? 2 : 1),
};

// ---------- REUSABLE UI ----------
const IconBtn = ({ icon, color = "#23b8f0", onPress }: any) => (
  <Pressable style={s.iconBtn} onPress={onPress}>
    <Ionicons name={icon} size={18} color={color} />
  </Pressable>
);

const Btn = ({ title, onPress, loading }: any) => (
  <Pressable style={[s.btn, loading && s.disabled]} disabled={loading} onPress={onPress}>
    {loading ? <ActivityIndicator size="small" color="#111" /> : <Ionicons name="search" size={16} color="#111" />}
    <Text style={s.btnText}>{loading ? "Scanning..." : title}</Text>
  </Pressable>
);

const SignalBars = ({ rssi }: { rssi: number | null }) => {
  const bars = U.bars(rssi);
  return (
    <View style={s.signal}>
      {[1, 2, 3, 4].map((i) => (
        <View key={i} style={[s.bar, { opacity: i <= bars ? 1 : 0.2 }]} />
      ))}
      <Text style={s.signalTxt}>{rssi ?? "—"}</Text>
    </View>
  );
};

// ---------- COMPONENT: Detection Card ----------
const DetectionCard = ({ item, router }: any) => (
  <Pressable
    style={({ pressed }) => [s.card, pressed && s.cardPressed]}
    onPress={() =>
      item.mac_address && router.push({ pathname: "/(tabs)/map", params: { mac: item.mac_address } })
    }
  >
    <View style={s.rowSpace}>
      <Text style={s.mac}>{item.mac_address}</Text>
      {item.signal_type && (
        <View style={s.badge}>
          <Text style={s.badgeTxt}>{item.signal_type}</Text>
        </View>
      )}
    </View>

    <View style={s.stats}>
      <SignalBars rssi={item.rssi} />
      <View>
        <Text style={s.label}>Distance</Text>
        <Text style={s.value}>{item.estimated_distance?.toFixed(1) ?? "—"}m</Text>
      </View>
      <View>
        <Text style={s.label}>Time</Text>
        <Text style={s.value}>{U.time(item.detected_at)}</Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color="#3a4a5a" />
    </View>
  </Pressable>
);

// =============================================================
// MAIN SCREEN
// =============================================================
export default function DetectionsScreen() {
  const router = useRouter();
  const { mac: paramMac } = useLocalSearchParams<{ mac?: string }>();

  const [detections, setDetections] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterMac, setFilterMac] = useState<string | undefined>(paramMac);

  const [devices, setDevices] = useState<SimpleBleDevice[]>([]);
  const [scanning, setScanning] = useState(false);

  const [isLive, setLive] = useState(false);
  const [liveDevice, setLiveDevice] = useState<SimpleBleDevice | null>(null);
  const [recentMacs, setRecentMacs] = useState(new Map());

  const liveRef = useRef(false);
  const recentRef = useRef(new Map());
  const trackRef = useRef<string | null>(null);

  // ---------- LOAD HISTORY ----------
  const load = async (mac?: string) => {
    setLoading(true);
    try {
      setDetections(await getDetections({ mac_address: mac, limit: 100 }));
    } catch {
      Alert.alert("Error", "Failed to load detections");
    }
    setLoading(false);
  };

  useEffect(() => {
    load(filterMac);
  }, [filterMac]);

  useEffect(() => {
    if (paramMac) setFilterMac(paramMac);
  }, [paramMac]);

  useEffect(() => {
    return () => {
      if (liveRef.current) stopLiveStream();
    };
  }, []);

  // ---------- BLUETOOTH SCAN ----------
  const scan = async () => {
    try {
      setScanning(true);
      if (Platform.OS === "android" && Platform.Version >= 31) {
        const perms = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        if (!Object.values(perms).every((p) => p === "granted")) {
          Alert.alert("Permission Required");
          return;
        }
      }

      const found = await scanForNearbyDevices(8000);
      setDevices(found);
      if (!found.length) Alert.alert("No Devices", "No BluStick nearby");
    } finally {
      setScanning(false);
    }
  };

  // ---------- START STREAM ----------
  const startLive = async (device: SimpleBleDevice) => {
    const token = await SecureStore.getItemAsync("token");
    if (!token) return Alert.alert("Not Authenticated", "Log in first");

    setLive(true);
    setLiveDevice(device);
    liveRef.current = true;
    recentRef.current = new Map();
    setRecentMacs(new Map());

    await collectDetectionsLive(
      null,
      async (batch) => {
        const target = trackRef.current?.toUpperCase();
        const filtered = target ? batch.filter((b) => b.mac_address?.toUpperCase() === target) : batch;

        if (filtered.length) {
          await createDetectionsBatch(filtered);
          load(filterMac);
        }
      },
      (status) => {
        if (status.lastDetection) {
          const m = status.lastDetection.mac_address;
          recentRef.current.set(m, {
            ...status.lastDetection,
            count: (recentRef.current.get(m)?.count ?? 0) + 1,
          });
          if (status.detectionCount % 3 === 0) setRecentMacs(new Map(recentRef.current));
        }
      },
      { deviceId: device.id }
    );

    setLive(false);
    setLiveDevice(null);
    liveRef.current = false;
  };

  useEffect(() => {
    if (!liveDevice) return;
    (async () => await startLive(liveDevice))();
  }, [liveDevice]);

  const stopLive = () => {
    stopLiveStream();
    liveRef.current = false;
    setLive(false);
    setLiveDevice(null);
  };

  const renderItem = useCallback(({ item }: any) => <DetectionCard item={item} router={router} />, []);

  const recentList = [...recentMacs.values()].slice(0, 8);

  return (
    <SafeAreaView style={s.root}>

      {/* Live or Connect */}
      <FlatList
        data={detections}
        keyExtractor={(it, idx) => `${it.mac_address}-${it.detected_at}-${idx}`}
        renderItem={renderItem}
        contentContainerStyle={s.list}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListHeaderComponent={
          <>
            {isLive && liveDevice ? (
              <View style={s.live}>
                <View style={s.rowSpace}>
                  <View style={s.liveBadge}><View style={s.dot}/><Text style={s.liveTxt}>LIVE</Text></View>
                  <Text style={s.liveName}>{liveDevice.name ?? liveDevice.id}</Text>
                  <IconBtn icon="stop" color="#fff" onPress={stopLive} />
                </View>

                {!trackRef.current ? (
                  <View style={s.recentBox}>
                    {!recentList.length ? (
                      <Text style={s.wait}>Waiting...</Text>
                    ) : recentList.map((r) => (
                      <Pressable key={r.mac_address} style={s.recentRow} onPress={() => (trackRef.current = r.mac_address)}>
                        <Text style={s.recentMac}>{r.mac_address}</Text>
                        <SignalBars rssi={r.rssi} />
                      </Pressable>
                    ))}
                  </View>
                ) : (
                  <View style={s.trackBox}>
                    <Text style={s.trackTxt}>Tracking {trackRef.current}</Text>
                    <IconBtn icon="close" onPress={() => (trackRef.current = null)} />
                  </View>
                )}
              </View>
            ) : (
              <View style={s.connection}>
                <Text style={s.subTitle}>Connect BluStick</Text>
                <Btn title="Scan for Devices" loading={scanning} onPress={scan} />
                {devices.map((d) => (
                  <Pressable key={d.id} style={s.deviceRow} onPress={() => setLiveDevice(d)}>
                    <Ionicons name="hardware-chip" size={18} color="#23b8f0" />
                    <View style={{ flex: 1 }}>
                      <Text style={s.deviceName}>{d.name ?? "BluStick"}</Text>
                      <Text style={s.deviceId}>{d.id}</Text>
                    </View>
                    <Ionicons name="radio" size={16} color="#ff3b30" />
                  </Pressable>
                ))}
              </View>
            )}

            {/* Filter */}
            <View style={[s.rowSpace, { marginBottom: 6 }]}>
              {filterMac ? (
                <Pressable style={s.filter} onPress={() => setFilterMac(undefined)}>
                  <Ionicons name="filter" size={12} color="#23b8f0" />
                  <Text style={s.filterTxt}>{U.mac(filterMac)}</Text>
                  <Ionicons name="close" size={14} color="#ff6b6b" />
                </Pressable>
              ) : (
                <Text style={s.label}>All Detections</Text>
              )}
              <View style={s.count}>
                <Text style={s.countTxt}>{detections.length}</Text>
              </View>
            </View>
          </>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator size="large" color="#23b8f0" />
          ) : (
            <Text style={s.empty}>No Data</Text>
          )
        }
      />
    </SafeAreaView>
  );
}

// ---------- STYLES ----------
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0a1018" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowSpace: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },

  list: { padding: 12, paddingBottom: 32 },

  iconBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#23b8f022",
  },

  // Card
  card: {
    backgroundColor: "#111a24",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#23b8f01f",
  },
  cardPressed: { backgroundColor: "#23b8f00f" },
  mac: { color: "#fff", fontSize: 13, fontWeight: "700", fontFamily: Mono },
  badge: { backgroundColor: "#23b8f022", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  badgeTxt: { color: "#23b8f0", fontSize: 10 },

  stats: { flexDirection: "row", alignItems: "center", gap: 16 },
  label: { color: "#6b7a8f", fontSize: 10 },
  value: { color: "#fff", fontSize: 12, fontWeight: "600" },

  signal: { flexDirection: "row", alignItems: "center", gap: 6 },
  bar: { width: 4, height: 10, backgroundColor: "#23b8f0", borderRadius: 1 },
  signalTxt: { fontSize: 11, color: "#23b8f0", fontFamily: Mono },

  // Live Panel
  live: {
    marginBottom: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#ff3b3022",
    borderWidth: 1,
    borderColor: "#ff3b30aa",
  },
  liveBadge: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#ff3b30", padding: 6, borderRadius: 4 },
  dot: { width: 6, height: 6, backgroundColor: "#fff", borderRadius: 3 },
  liveTxt: { color: "#fff", fontSize: 10, fontWeight: "700" },
  liveName: { color: "#fff", flex: 1 },

  recentBox: { marginTop: 10 },
  wait: { color: "#445", textAlign: "center", padding: 10 },
  recentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 10,
    backgroundColor: "#111a24",
    borderRadius: 10,
    marginBottom: 6,
  },
  recentMac: { color: "#fff", fontFamily: Mono },

  trackBox: {
    marginTop: 10,
    backgroundColor: "#00ffaa22",
    padding: 12,
    borderRadius: 10,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  trackTxt: { color: "#00ffaa", fontWeight: "700", fontFamily: Mono },

  // Connect Panel
  connection: {
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "#111a24",
    borderWidth: 1,
    borderColor: "#23b8f01f",
  },
  subTitle: { color: "#c9d5e3", fontSize: 14, marginBottom: 10 },
  btn: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#23b8f0",
    padding: 12,
    borderRadius: 10,
  },
  btnText: { fontWeight: "700", color: "#111" },
  disabled: { opacity: 0.5 },

  deviceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#111",
    padding: 10,
    borderRadius: 10,
    marginTop: 8,
  },
  deviceName: { color: "#fff", fontWeight: "600" },
  deviceId: { color: "#666", fontFamily: Mono, fontSize: 10 },

  filter: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: "#23b8f022",
  },
  filterTxt: { color: "#23b8f0", fontFamily: Mono, fontSize: 12 },

  count: { backgroundColor: "#23b8f022", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  countTxt: { color: "#23b8f0", fontWeight: "700" },

  empty: { color: "#445", textAlign: "center", marginTop: 50, fontSize: 16 },
});
