// app/(tabs)/detections.tsx - UPDATED with Search Mode Flow
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

// ---------- TYPES ----------
type MacSummary = {
  mac_address: string;
  count: number;
  last_rssi: number | null;
  last_distance: number | null;
};

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

const Btn = ({ title, onPress, loading, icon = "search" }: any) => (
  <Pressable style={[s.btn, loading && s.disabled]} disabled={loading} onPress={onPress}>
    {loading ? <ActivityIndicator size="small" color="#111" /> : <Ionicons name={icon} size={16} color="#111" />}
    <Text style={s.btnText}>{title}</Text>
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

  // Search mode states
  const [searchModeActive, setSearchModeActive] = useState(false); // ESP is in search mode
  const [searchMacList, setSearchMacList] = useState<MacSummary[]>([]); // MACs from last 10 mins
  const [trackingMac, setTrackingMac] = useState<string | null>(null); // Single MAC being tracked
  const [searchModeLoading, setSearchModeLoading] = useState(false);
  const [macSearchInput, setMacSearchInput] = useState<string>("");

  const liveRef = useRef(false);
  const refreshIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const searchModeActiveRef = useRef(false);
  const trackingMacRef = useRef<string | null>(null);

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

  // ---------- START SEARCH MODE (fetch last 10 mins from DB, show list) ----------
  const startSearchMode = async () => {
    setSearchModeLoading(true);
    try {
      // Fetch recent detections from DB (high limit to get last 10 mins)
      console.log('[Search Mode] Fetching recent detections from DB...');
      const allDetections = await getDetections({ limit: 500 });
      
      // Filter to last 10 minutes
      const tenMinsAgo = Date.now() - (10 * 60 * 1000);
      const recentDetections = allDetections.filter(d => {
        const detTime = new Date(d.detected_at).getTime();
        return detTime >= tenMinsAgo;
      });
      
      console.log(`[Search Mode] Found ${recentDetections.length} detections in last 10 mins`);
      
      if (recentDetections.length === 0) {
        Alert.alert("No Recent Data", "No detections found in the last 10 minutes. Keep collecting data and try again.");
        setSearchModeLoading(false);
        return;
      }
      
      // Group by MAC address and count
      const macMap = new Map<string, MacSummary>();
      for (const d of recentDetections) {
        if (!d.mac_address) continue;
        
        const existing = macMap.get(d.mac_address);
        if (existing) {
          existing.count++;
          // Keep most recent RSSI/distance
          existing.last_rssi = d.rssi;
          existing.last_distance = d.estimated_distance;
        } else {
          macMap.set(d.mac_address, {
            mac_address: d.mac_address,
            count: 1,
            last_rssi: d.rssi,
            last_distance: d.estimated_distance,
          });
        }
      }
      
      // Sort by count (most detected first), limit to top 50 to avoid overwhelming
      const sortedMacs = Array.from(macMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 50);
      
      console.log(`[Search Mode] ${sortedMacs.length} unique MACs ready to display`);
      
      // Just show the list - don't send to ESP yet
      // ESP will be activated when user picks a specific MAC
      setSearchMacList(sortedMacs);
      setSearchModeActive(true);
      searchModeActiveRef.current = true;
      
    } catch (e: any) {
      console.error('[Search Mode] Failed:', e);
      Alert.alert("Search Mode Error", e?.message || "Failed to start search mode");
    } finally {
      setSearchModeLoading(false);
    }
  };

  // ---------- SELECT SPECIFIC MAC TO TRACK ----------
  const selectMacToTrack = async (mac: string) => {
    setSearchModeLoading(true);
    try {
      // Send just this one MAC to ESP - this activates search mode on ESP
      await activateSearchModeLive(mac);
      
      setTrackingMac(mac);
      trackingMacRef.current = mac;
      console.log('[Search Mode] Now tracking single MAC:', mac);
    } catch (e: any) {
      console.error('[Search Mode] Failed to select MAC:', e);
      Alert.alert("Error", e?.message || "Failed to select device");
    } finally {
      setSearchModeLoading(false);
    }
  };

  // ---------- MANUAL MAC INPUT ----------
  const handleMacInputChange = (text: string) => {
    const cleaned = text.toUpperCase().replace(/[^0-9A-F]/g, '');
    let formatted = '';
    for (let i = 0; i < cleaned.length && i < 12; i++) {
      if (i > 0 && i % 2 === 0) formatted += ':';
      formatted += cleaned[i];
    }
    setMacSearchInput(formatted);
  };

  const handleManualMacSearch = async () => {
    const cleanMac = macSearchInput.trim().toUpperCase();
    const macRegex = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
    if (!macRegex.test(cleanMac)) {
      Alert.alert("Invalid MAC", "Enter a valid MAC address\n(e.g. AA:BB:CC:DD:EE:FF)");
      return;
    }
    await selectMacToTrack(cleanMac);
    setMacSearchInput("");
  };

  // ---------- STOP SEARCH MODE ----------
  const stopSearchMode = async () => {
    setSearchModeLoading(true);
    try {
      await deactivateSearchModeLive();
      console.log('[Search Mode] Deactivated');
    } catch (e: any) {
      console.warn('[Search Mode] Deactivate warning:', e?.message);
    }
    setTrackingMac(null);
    trackingMacRef.current = null;
    setSearchModeActive(false);
    searchModeActiveRef.current = false;
    setSearchMacList([]);
    setSearchModeLoading(false);
  };

  // ---------- BACK TO MAC LIST (from single tracking) ----------
  const backToMacList = async () => {
    setSearchModeLoading(true);
    try {
      // Deactivate search mode on ESP (stop tracking)
      await deactivateSearchModeLive();
      setTrackingMac(null);
      trackingMacRef.current = null;
      console.log('[Search Mode] Back to MAC list selection');
    } catch (e: any) {
      console.error('[Search Mode] Failed to go back:', e);
    } finally {
      setSearchModeLoading(false);
    }
  };

  // ---------- START STREAM ----------
  const startLive = async (device: SimpleBleDevice) => {
    const token = await SecureStore.getItemAsync("token");
    if (!token) return Alert.alert("Not Authenticated", "Log in first");

    setLive(true);
    setLiveDevice(device);
    liveRef.current = true;
    setTrackingMac(null);
    trackingMacRef.current = null;
    setSearchModeActive(false);
    searchModeActiveRef.current = false;
    setSearchMacList([]);

    // Start periodic refresh of detection list (only when not in search mode)
    refreshIntervalRef.current = setInterval(() => {
      // Only refresh if not in search/tracking mode (use refs for current values)
      if (!searchModeActiveRef.current && !trackingMacRef.current) {
        load(filterMac);
      }
    }, 5000); // 5 seconds

    await collectDetectionsLive(
      null,
      async (batch) => {
        if (batch.length) {
          await createDetectionsBatch(batch);
        }
      },
      (status) => {
        // Status updates (optional logging)
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
    trackingMacRef.current = null;
    setSearchModeActive(false);
    searchModeActiveRef.current = false;
    setSearchMacList([]);
  };

  useEffect(() => {
    if (!liveDevice) return;
    (async () => await startLive(liveDevice))();
  }, [liveDevice]);

  // ---------- STOP STREAM ----------
  const stopLive = async () => {
    if (refreshIntervalRef.current) {
      clearInterval(refreshIntervalRef.current);
      refreshIntervalRef.current = null;
    }
    
    // Deactivate search mode if active
    if (searchModeActive || trackingMac) {
      try {
        await deactivateSearchModeLive();
      } catch (e) {
        console.warn('[Search Mode] Deactivate on stop warning:', e);
      }
    }
    
    stopLiveStream();
    liveRef.current = false;
    setLive(false);
    setLiveDevice(null);
    setTrackingMac(null);
    setSearchModeActive(false);
    setSearchMacList([]);
    
    load(filterMac);
  };

  const renderItem = useCallback(({ item }: any) => <DetectionCard item={item} router={router} />, []);

  return (
    <SafeAreaView style={s.root}>
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
                {/* Header with LIVE badge and stop button */}
                <View style={s.rowSpace}>
                  <View style={s.liveBadge}>
                    <View style={s.dot}/>
                    <Text style={s.liveTxt}>LIVE</Text>
                  </View>
                  <Text style={s.liveName}>{liveDevice.name ?? liveDevice.id}</Text>
                  <IconBtn icon="stop" color="#fff" onPress={stopLive} />
                </View>

                {/* STATE 1: Connected, not in search mode */}
                {!searchModeActive && !trackingMac && (
                  <View style={s.connectedBox}>
                    <View style={s.connectedStatus}>
                      <Ionicons name="checkmark-circle" size={20} color="#00ffaa" />
                      <Text style={s.connectedText}>Connected - Collecting data</Text>
                    </View>
                    <Text style={s.connectedSubtext}>
                      Data is being uploaded to the database in the background.
                    </Text>
                    
                    <Pressable
                      style={[s.startSearchBtn, searchModeLoading && s.disabled]}
                      onPress={startSearchMode}
                      disabled={searchModeLoading}
                    >
                      {searchModeLoading ? (
                        <ActivityIndicator size="small" color="#111" />
                      ) : (
                        <>
                          <Ionicons name="search" size={18} color="#111" />
                          <Text style={s.startSearchTxt}>Start Search</Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                )}

                {/* STATE 2: Search mode active, showing MAC list */}
                {searchModeActive && !trackingMac && (
                  <View style={s.searchListBox}>
                    <View style={s.searchListHeader}>
                      <View style={s.row}>
                        <Ionicons name="locate" size={16} color="#23b8f0" />
                        <Text style={s.searchListTitle}>Search Mode Active</Text>
                      </View>
                      <Pressable 
                        style={s.cancelBtn}
                        onPress={stopSearchMode}
                        disabled={searchModeLoading}
                      >
                        <Text style={s.cancelTxt}>Cancel</Text>
                      </Pressable>
                    </View>
                    
                    <Text style={s.searchListSubtitle}>
                      {searchMacList.length} devices from last 10 mins • Tap to track
                    </Text>
                    
                    {/* Manual MAC input */}
                    <View style={s.searchInputRow}>
                      <TextInput
                        style={s.macInput}
                        placeholder="Or enter MAC: AA:BB:CC:DD:EE:FF"
                        placeholderTextColor="#6b7a8f"
                        value={macSearchInput}
                        onChangeText={handleMacInputChange}
                        autoCapitalize="characters"
                        autoCorrect={false}
                      />
                      <Pressable 
                        style={[s.searchBtn, (macSearchInput.length !== 17 || searchModeLoading) && s.disabled]}
                        onPress={handleManualMacSearch}
                        disabled={macSearchInput.length !== 17 || searchModeLoading}
                      >
                        <Ionicons name="arrow-forward" size={18} color="#111" />
                      </Pressable>
                    </View>
                    
                    {/* MAC list */}
                    {searchMacList.map((item, idx) => (
                      <Pressable
                        key={item.mac_address}
                        style={[s.macListRow, searchModeLoading && s.disabled]}
                        onPress={() => selectMacToTrack(item.mac_address)}
                        onLongPress={() => router.push({ pathname: "/(tabs)/map", params: { mac: item.mac_address } })}
                        disabled={searchModeLoading}
                      >
                        <View style={s.macListLeft}>
                          <Text style={s.macListRank}>#{idx + 1}</Text>
                          <Text style={s.macListMac}>{item.mac_address}</Text>
                        </View>
                        <View style={s.macListRight}>
                          <View style={s.countBadge}>
                            <Text style={s.countBadgeTxt}>{item.count}x</Text>
                          </View>
                          <SignalBars rssi={item.last_rssi} />
                          <Ionicons name="chevron-forward" size={14} color="#3a4a5a" />
                        </View>
                      </Pressable>
                    ))}
                  </View>
                )}

                {/* STATE 3: Tracking a single MAC */}
                {trackingMac && (
                  <View style={s.trackBox}>
                    <View style={s.trackHeader}>
                      <Ionicons name="locate" size={16} color="#00ffaa" />
                      <Text style={s.trackLabel}>TRACKING DEVICE</Text>
                    </View>
                    <Text style={s.trackMac}>{trackingMac}</Text>
                    
                    <View style={s.trackActions}>
                      <Pressable 
                        style={[s.backBtn, searchModeLoading && s.disabled]}
                        onPress={backToMacList}
                        disabled={searchModeLoading}
                      >
                        <Ionicons name="arrow-back" size={14} color="#23b8f0" />
                        <Text style={s.backBtnTxt}>Back to list</Text>
                      </Pressable>
                      
                      <Pressable 
                        style={[s.stopSearchBtn, searchModeLoading && s.disabled]}
                        onPress={stopSearchMode}
                        disabled={searchModeLoading}
                      >
                        {searchModeLoading ? (
                          <ActivityIndicator size="small" color="#ff6b6b" />
                        ) : (
                          <>
                            <Ionicons name="close-circle" size={16} color="#ff6b6b" />
                            <Text style={s.stopSearchTxt}>Stop</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                    
                    <Pressable
                      style={s.viewMapBtn}
                      onPress={() => router.push({ pathname: "/(tabs)/map", params: { mac: trackingMac } })}
                    >
                      <Ionicons name="map" size={16} color="#111" />
                      <Text style={s.viewMapTxt}>View on Map</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            ) : (
              /* Not connected - show scan/connect UI */
              <View style={s.connection}>
                <Text style={s.subTitle}>Connect BluStick</Text>
                <Btn title={scanning ? "Scanning..." : "Scan for Devices"} loading={scanning} onPress={scan} />
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

            {/* Filter bar */}
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
  row: { flexDirection: "row", alignItems: "center", gap: 6 },
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

  // Connected state (before search)
  connectedBox: {
    marginTop: 12,
    padding: 12,
    backgroundColor: "#111a24",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#00ffaa33",
  },
  connectedStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  connectedText: {
    color: "#00ffaa",
    fontSize: 14,
    fontWeight: "600",
  },
  connectedSubtext: {
    color: "#6b7a8f",
    fontSize: 12,
    marginBottom: 12,
  },
  startSearchBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#23b8f0",
    padding: 14,
    borderRadius: 10,
  },
  startSearchTxt: {
    color: "#111",
    fontWeight: "700",
    fontSize: 14,
  },

  // Search list box
  searchListBox: {
    marginTop: 12,
    backgroundColor: "#111a24",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#23b8f044",
  },
  searchListHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  searchListTitle: {
    color: "#23b8f0",
    fontSize: 13,
    fontWeight: "700",
  },
  cancelBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cancelTxt: {
    color: "#ff6b6b",
    fontSize: 12,
    fontWeight: "600",
  },
  searchListSubtitle: {
    color: "#6b7a8f",
    fontSize: 11,
    marginBottom: 10,
  },
  
  // MAC search input
  searchInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10,
  },
  macInput: {
    flex: 1,
    backgroundColor: "#0a1018",
    borderRadius: 8,
    padding: 10,
    color: "#fff",
    fontFamily: Mono,
    fontSize: 12,
    borderWidth: 1,
    borderColor: "#23b8f033",
  },
  searchBtn: {
    backgroundColor: "#23b8f0",
    width: 40,
    height: 40,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  
  // MAC list row
  macListRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 10,
    backgroundColor: "#0a1018",
    borderRadius: 8,
    marginBottom: 6,
  },
  macListLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  macListRank: {
    color: "#6b7a8f",
    fontSize: 11,
    fontWeight: "600",
    width: 24,
  },
  macListMac: {
    color: "#fff",
    fontFamily: Mono,
    fontSize: 12,
  },
  macListRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  countBadge: {
    backgroundColor: "#23b8f022",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  countBadgeTxt: {
    color: "#23b8f0",
    fontSize: 10,
    fontWeight: "700",
  },

  // Tracking box
  trackBox: {
    marginTop: 12,
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
  trackActions: {
    flexDirection: "row",
    gap: 10,
    marginBottom: 10,
  },
  backBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: "#23b8f022",
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#23b8f044",
  },
  backBtnTxt: {
    color: "#23b8f0",
    fontWeight: "600",
    fontSize: 12,
  },
  stopSearchBtn: {
    flex: 1,
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
    fontSize: 12,
  },
  viewMapBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#23b8f0",
    padding: 12,
    borderRadius: 8,
  },
  viewMapTxt: {
    color: "#111",
    fontWeight: "700",
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