// app/(tabs)/detections.tsx - UPDATED
import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View, Text, FlatList, ActivityIndicator, Pressable, StyleSheet,
  Alert, Platform, PermissionsAndroid, TextInput
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
  activateSearchModeLive, deactivateSearchModeLive,
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
const IconBtn = ({ icon, color = "#23b8f0", onPress, disabled = false }: any) => (
  <Pressable 
    style={[s.iconBtn, disabled && s.disabled]} 
    onPress={onPress}
    disabled={disabled}
  >
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
        <Text style={s.value}>
          {item.estimated_distance != null && item.estimated_distance !== ""
            ? `${item.estimated_distance.toFixed(1)}m`
            : "—"}
        </Text>
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

  // Search mode state
  const [trackingMac, setTrackingMac] = useState<string | null>(null);
  const [searchModeLoading, setSearchModeLoading] = useState(false);
  const [macSearchInput, setMacSearchInput] = useState<string>("");

  const liveRef = useRef(false);
  const recentRef = useRef(new Map());
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);

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
      if (refreshIntervalRef.current) {
        clearInterval(refreshIntervalRef.current);
        refreshIntervalRef.current = null;
      }
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

  // ---------- SEARCH MODE CONTROLS ----------
  const activateSearchMode = async (mac: string) => {
    setSearchModeLoading(true);
    try {
      await activateSearchModeLive(mac);
      setTrackingMac(mac);
      setMacSearchInput("");
      console.log('[Search Mode] Activated for:', mac);
    } catch (e: any) {
      console.error('[Search Mode] Failed to activate:', e);
      Alert.alert("Search Mode Error", e?.message || "Failed to activate search mode");
    } finally {
      setSearchModeLoading(false);
    }
  };

  const handleMacInputChange = (text: string) => {
    // Remove all non-hex characters
    const cleaned = text.toUpperCase().replace(/[^0-9A-F]/g, '');
    
    // Add colons every 2 characters
    let formatted = '';
    for (let i = 0; i < cleaned.length && i < 12; i++) {
      if (i > 0 && i % 2 === 0) {
        formatted += ':';
      }
      formatted += cleaned[i];
    }
    
    setMacSearchInput(formatted);
  };

  const handleManualMacSearch = () => {
    // Clean up input - remove spaces, uppercase
    const cleanMac = macSearchInput.trim().toUpperCase();
    
    // Validate MAC format (XX:XX:XX:XX:XX:XX)
    const macRegex = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
    if (!macRegex.test(cleanMac)) {
      Alert.alert("Invalid MAC", "Enter a valid MAC address\n(e.g. AA:BB:CC:DD:EE:FF)");
      return;
    }
    
    activateSearchMode(cleanMac);
  };

  const deactivateSearchMode = async () => {
    setSearchModeLoading(true);
    try {
      await deactivateSearchModeLive();
      console.log('[Search Mode] Deactivated');
    } catch (e: any) {
      // Log but don't alert - the ESP probably got the message
      console.warn('[Search Mode] Deactivate warning:', e?.message);
    }
    // Always clear tracking state regardless of error
    setTrackingMac(null);
    setSearchModeLoading(false);
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
    setTrackingMac(null);

    // Start periodic refresh of detection list
    refreshIntervalRef.current = setInterval(() => {
      load(filterMac);
    }, 3000); // Refresh every 3 seconds

    await collectDetectionsLive(
      null,
      async (batch) => {
        // ESP handles filtering when in search mode, so just upload everything
        if (batch.length) {
          await createDetectionsBatch(batch);
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

    // Cleanup when stream ends
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
    
    setLive(false);
    setLiveDevice(null);
    liveRef.current = false;
    setTrackingMac(null);
  };

  useEffect(() => {
    if (!liveDevice) return;
    (async () => await startLive(liveDevice))();
  }, [liveDevice]);

  // ---------- STOP STREAM ----------
  const stopLive = async () => {
    // Clear refresh interval
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
    
    // Deactivate search mode first if active (don't fail hard)
    if (trackingMac) {
      try {
        await deactivateSearchModeLive();
      } catch (e) {
        console.warn('[Search Mode] Deactivate on stop warning:', e);
      }
      setTrackingMac(null);
    }
    
    stopLiveStream();
    liveRef.current = false;
    setLive(false);
    setLiveDevice(null);
    
    // Final refresh to get latest data
    load(filterMac);
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

                {!trackingMac ? (
                  <View style={s.recentBox}>
                    {/* Manual MAC search input */}
                    <View style={s.searchInputRow}>
                      <TextInput
                        style={s.macInput}
                        placeholder="AA:BB:CC:DD:EE:FF"
                        placeholderTextColor="#6b7a8f"
                        value={macSearchInput}
                        onChangeText={handleMacInputChange}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        keyboardType="ascii-capable"
                      />
                      <Pressable 
                        style={[s.searchBtn, (macSearchInput.length !== 17 || searchModeLoading) && s.disabled]}
                        onPress={handleManualMacSearch}
                        disabled={macSearchInput.length !== 17 || searchModeLoading}
                      >
                        {searchModeLoading ? (
                          <ActivityIndicator size="small" color="#111" />
                        ) : (
                          <Ionicons name="search" size={18} color="#111" />
                        )}
                      </Pressable>
                    </View>
                    
                    {!recentList.length ? (
                      <Text style={s.wait}>Waiting for detections...</Text>
                    ) : (
                      <>
                        <Text style={s.recentTitle}>Tap to track • Long press for map:</Text>
                        {recentList.map((r) => (
                          <Pressable 
                            key={r.mac_address} 
                            style={[s.recentRow, searchModeLoading && s.disabled]} 
                            onPress={() => activateSearchMode(r.mac_address)}
                            onLongPress={() => router.push({ pathname: "/(tabs)/map", params: { mac: r.mac_address } })}
                            disabled={searchModeLoading}
                          >
                            <Text style={s.recentMac}>{r.mac_address}</Text>
                            <View style={s.recentRowRight}>
                              <SignalBars rssi={r.rssi} />
                              <Ionicons name="map-outline" size={14} color="#3a4a5a" />
                            </View>
                          </Pressable>
                        ))}
                      </>
                    )}
                  </View>
                ) : (
                  <View style={s.trackBox}>
                    <View style={s.trackHeader}>
                      <Ionicons name="locate" size={16} color="#00ffaa" />
                      <Text style={s.trackLabel}>SEARCH MODE ACTIVE</Text>
                    </View>
                    <Text style={s.trackMac}>{trackingMac}</Text>
                    <Pressable 
                      style={[s.stopSearchBtn, searchModeLoading && s.disabled]}
                      onPress={deactivateSearchMode}
                      disabled={searchModeLoading}
                    >
                      {searchModeLoading ? (
                        <ActivityIndicator size="small" color="#ff6b6b" />
                      ) : (
                        <>
                          <Ionicons name="close-circle" size={16} color="#ff6b6b" />
                          <Text style={s.stopSearchTxt}>Stop Search</Text>
                        </>
                      )}
                    </Pressable>
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

  stats: { flexDirection: "row", alignItems: "center", gap: 16, marginTop: 8 },
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
  liveName: { color: "#fff", flex: 1, marginLeft: 8 },

  recentBox: { marginTop: 10 },
  recentTitle: { color: "#6b7a8f", fontSize: 11, marginBottom: 8, marginTop: 10 },
  
  // MAC Search Input
  searchInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  macInput: {
    flex: 1,
    backgroundColor: "#111a24",
    borderRadius: 10,
    padding: 12,
    color: "#fff",
    fontFamily: Mono,
    fontSize: 13,
    borderWidth: 1,
    borderColor: "#23b8f033",
  },
  searchBtn: {
    backgroundColor: "#23b8f0",
    width: 44,
    height: 44,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  wait: { color: "#6b7a8f", textAlign: "center", padding: 10 },
  recentRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 10,
    backgroundColor: "#111a24",
    borderRadius: 10,
    marginBottom: 6,
  },
  recentMac: { color: "#fff", fontFamily: Mono, fontSize: 12 },
  recentRowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },

  // Search Mode / Tracking Box
  trackBox: {
    marginTop: 10,
    backgroundColor: "#00ffaa15",
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#00ffaa44",
  },
  trackHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  trackLabel: { 
    color: "#00ffaa", 
    fontSize: 10, 
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  trackMac: { 
    color: "#fff", 
    fontWeight: "700", 
    fontFamily: Mono,
    fontSize: 14,
    marginBottom: 10,
  },
  stopSearchBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#ff6b6b22",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#ff6b6b44",
  },
  stopSearchTxt: {
    color: "#ff6b6b",
    fontWeight: "600",
    fontSize: 13,
  },

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

  empty: { color: "#6b7a8f", textAlign: "center", marginTop: 50, fontSize: 16 },
});