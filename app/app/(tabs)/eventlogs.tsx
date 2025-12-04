// app/(tabs)/eventlogs.tsx - Redesigned to match detections.tsx
import React, { useEffect, useState, useRef, useCallback } from "react";
import {
  View, Text, FlatList, Pressable, ActivityIndicator,
  RefreshControl, Platform, StyleSheet
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { getDeviceMacSummaries, DeviceMacSummary } from "../../api";

const Mono = Platform.select({ ios: "Menlo", android: "monospace" });

// ---------- UTILITIES ----------
const U = {
  mac: (m?: string) => (m && m.length > 11 ? `${m.slice(0, 8)}…${m.slice(-5)}` : m ?? "—"),
  timeAgo: (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  },
  isRecent: (d: string) => Date.now() - new Date(d).getTime() < 10 * 60 * 1000,
  date: (d: string) => new Date(d).toLocaleDateString([], { month: "short", day: "numeric" }),
};

// ---------- REUSABLE UI ----------
const IconBtn = ({ icon, color = "#23b8f0", onPress }: any) => (
  <Pressable style={s.iconBtn} onPress={onPress}>
    <Ionicons name={icon} size={16} color={color} />
  </Pressable>
);

const Toggle = ({ active, onToggle, leftLabel, rightLabel, rightCount }: any) => (
  <View style={s.toggle}>
    <Pressable style={[s.toggleBtn, !active && s.toggleActive]} onPress={() => onToggle(false)}>
      <Text style={[s.toggleTxt, !active && s.toggleTxtActive]}>{leftLabel}</Text>
    </Pressable>
    <Pressable style={[s.toggleBtn, active && s.toggleActive]} onPress={() => onToggle(true)}>
      <Text style={[s.toggleTxt, active && s.toggleTxtActive]}>{rightLabel}</Text>
      {rightCount > 0 && <View style={s.toggleBadge}><Text style={s.toggleBadgeTxt}>{rightCount}</Text></View>}
    </Pressable>
  </View>
);

// ---------- DEVICE CARD ----------
const DeviceCard = ({ item, router }: { item: DeviceMacSummary; router: any }) => {
  const recent = U.isRecent(item.last_seen);
  
  return (
    <Pressable
      style={({ pressed }) => [s.card, recent && s.cardRecent, pressed && s.cardPressed]}
      onPress={() => router.push({ pathname: "/(tabs)/detections", params: { mac: item.mac_address } })}
    >
      <View style={s.rowSpace}>
        <View style={s.row}>
          {recent && <View style={s.dot} />}
          <Text style={s.mac}>{item.mac_address}</Text>
        </View>
        <View style={s.badge}>
          <Text style={[s.badgeTxt, recent && s.badgeTxtRecent]}>{U.timeAgo(item.last_seen)}</Text>
        </View>
      </View>

      <View style={s.stats}>
        <View>
          <Text style={s.label}>Detections</Text>
          <Text style={s.value}>{item.detection_count}</Text>
        </View>
        <View>
          <Text style={s.label}>First Seen</Text>
          <Text style={s.value}>{U.date(item.first_seen)}</Text>
        </View>
        <IconBtn
          icon="map-outline"
          onPress={() => router.push({ pathname: "/(tabs)/map", params: { mac: item.mac_address } })}
        />
        <Ionicons name="chevron-forward" size={16} color="#3a4a5a" />
      </View>
    </Pressable>
  );
};

// =============================================================
// MAIN SCREEN
// =============================================================
export default function EventLogsScreen() {
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceMacSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const autoRef = useRef<NodeJS.Timeout | null>(null);

  const load = async () => {
    try {
      if (!refreshing) setLoading(true);
      const data = await getDeviceMacSummaries();
      setDevices(data.sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime()));
    } catch {
      // Silent fail, show empty state
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (recentOnly) {
      autoRef.current = setInterval(load, 10000);
    } else if (autoRef.current) {
      clearInterval(autoRef.current);
    }
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [recentOnly]);

  const displayed = recentOnly ? devices.filter(d => U.isRecent(d.last_seen)) : devices;
  const recentCount = devices.filter(d => U.isRecent(d.last_seen)).length;
  const totalDetections = devices.reduce((sum, d) => sum + d.detection_count, 0);

  const renderItem = useCallback(
    ({ item }: { item: DeviceMacSummary }) => <DeviceCard item={item} router={router} />,
    []
  );

  return (
    <SafeAreaView style={s.root}>
      <FlatList
        data={displayed}
        keyExtractor={(item) => item.mac_address}
        renderItem={renderItem}
        contentContainerStyle={s.list}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(); }}
            tintColor="#23b8f0"
          />
        }
        ListHeaderComponent={
          <>
            {/* Stats Summary */}
            <View style={s.summary}>
              <View style={s.statBox}>
                <Text style={s.statNum}>{devices.length}</Text>
                <Text style={s.statLabel}>Devices</Text>
              </View>
              <View style={s.statBox}>
                <Text style={s.statNum}>{totalDetections}</Text>
                <Text style={s.statLabel}>Total</Text>
              </View>
              <View style={s.statBox}>
                <Text style={[s.statNum, recentCount > 0 && s.statNumActive]}>{recentCount}</Text>
                <Text style={s.statLabel}>Active</Text>
              </View>
            </View>

            {/* Filter Toggle */}
            <View style={s.filterRow}>
              <Toggle
                active={recentOnly}
                onToggle={setRecentOnly}
                leftLabel="All"
                rightLabel="Recent"
                rightCount={recentCount}
              />
              {recentOnly && (
                <View style={s.autoTag}>
                  <View style={s.pulse} />
                  <Text style={s.autoTxt}>Auto</Text>
                </View>
              )}
            </View>

            {/* Count */}
            <View style={[s.rowSpace, { marginBottom: 6 }]}>
              <Text style={s.label}>{displayed.length} device{displayed.length !== 1 ? "s" : ""}</Text>
            </View>
          </>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator size="large" color="#23b8f0" style={{ marginTop: 50 }} />
          ) : (
            <View style={s.empty}>
              <Ionicons name={recentOnly ? "time-outline" : "bluetooth-outline"} size={48} color="#3a4a5a" />
              <Text style={s.emptyTitle}>{recentOnly ? "No Recent Devices" : "No Devices"}</Text>
              <Text style={s.emptySubtitle}>
                {recentOnly ? "None detected in last 10 min" : "Connect BluStick to start"}
              </Text>
            </View>
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

  // Summary
  summary: {
    flexDirection: "row",
    justifyContent: "space-around",
    backgroundColor: "#111a24",
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#23b8f01f",
  },
  statBox: { alignItems: "center" },
  statNum: { color: "#23b8f0", fontSize: 18, fontWeight: "800" },
  statNumActive: { color: "#00ffaa" },
  statLabel: { color: "#6b7a8f", fontSize: 10, marginTop: 2 },

  // Toggle
  filterRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
  toggle: { flex: 1, flexDirection: "row", backgroundColor: "#111a24", borderRadius: 8, padding: 4 },
  toggleBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8, borderRadius: 6 },
  toggleActive: { backgroundColor: "#23b8f0" },
  toggleTxt: { color: "#6b7a8f", fontSize: 12, fontWeight: "600" },
  toggleTxtActive: { color: "#111" },
  toggleBadge: { backgroundColor: "#00ffaa", paddingHorizontal: 5, paddingVertical: 1, borderRadius: 6 },
  toggleBadgeTxt: { color: "#111", fontSize: 9, fontWeight: "700" },
  autoTag: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "#23b8f022", paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6 },
  pulse: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#23b8f0" },
  autoTxt: { color: "#23b8f0", fontSize: 10, fontWeight: "600" },

  // Card
  card: {
    backgroundColor: "#111a24",
    borderRadius: 10,
    padding: 12,
    borderWidth: 1,
    borderColor: "#23b8f01f",
  },
  cardRecent: { borderLeftWidth: 3, borderLeftColor: "#00ffaa" },
  cardPressed: { backgroundColor: "#23b8f00f" },
  mac: { color: "#fff", fontSize: 13, fontWeight: "700", fontFamily: Mono },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#00ffaa" },
  badge: { backgroundColor: "#23b8f022", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  badgeTxt: { color: "#6b7a8f", fontSize: 10 },
  badgeTxtRecent: { color: "#00ffaa" },
  stats: { flexDirection: "row", alignItems: "center", gap: 20, marginTop: 10 },
  label: { color: "#6b7a8f", fontSize: 10 },
  value: { color: "#fff", fontSize: 12, fontWeight: "600" },

  iconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#23b8f022",
    marginLeft: "auto",
  },

  // Empty
  empty: { alignItems: "center", marginTop: 60, gap: 8 },
  emptyTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  emptySubtitle: { color: "#6b7a8f", fontSize: 13 },
});