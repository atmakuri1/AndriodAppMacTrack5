// app/(tabs)/eventlogs.tsx - Simplified Device List
import React, { useEffect, useState, useRef } from "react";
import { View, Text, FlatList, Pressable, ActivityIndicator, RefreshControl, Platform, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { getDeviceMacSummaries, DeviceMacSummary } from "../../api";
import { Ionicons } from "@expo/vector-icons";

const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

// Time formatting helper
const getTimeAgo = (dateString: string) => {
  const diff = Date.now() - new Date(dateString).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  return `${days}d ago`;
};

// Check if device was seen in last 10 minutes
const isRecent = (dateString: string) => {
  return Date.now() - new Date(dateString).getTime() < 10 * 60 * 1000;
};

export default function EventLogsScreen() {
  const router = useRouter();
  const [devices, setDevices] = useState<DeviceMacSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showRecentOnly, setShowRecentOnly] = useState(false);
  const autoRefresh = useRef<NodeJS.Timeout | null>(null);

  const loadDevices = async () => {
    try {
      setError(null);
      if (!refreshing) setLoading(true);
      const data = await getDeviceMacSummaries();
      // Sort by last seen (newest first)
      const sorted = data.sort((a, b) => 
        new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime()
      );
      setDevices(sorted);
    } catch (e: any) {
      setError(e?.message || "Failed to load devices");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Auto-refresh when showing recent only
  useEffect(() => {
    if (showRecentOnly) {
      autoRefresh.current = setInterval(loadDevices, 10000);
    } else {
      if (autoRefresh.current) clearInterval(autoRefresh.current);
    }
    return () => { if (autoRefresh.current) clearInterval(autoRefresh.current); };
  }, [showRecentOnly]);

  useEffect(() => { loadDevices(); }, []);

  // Filter devices
  const displayedDevices = showRecentOnly 
    ? devices.filter(d => isRecent(d.last_seen))
    : devices;

  const recentCount = devices.filter(d => isRecent(d.last_seen)).length;
  const totalDetections = devices.reduce((sum, d) => sum + d.detection_count, 0);

  // Navigate to detections filtered by MAC
  const viewDevice = (mac: string) => {
    router.push({ pathname: "/(tabs)/detections", params: { mac } });
  };

  // Navigate to map for this MAC
  const viewOnMap = (mac: string) => {
    router.push({ pathname: "/(tabs)/map", params: { mac } });
  };

  // Render device card
  const renderDevice = ({ item }: { item: DeviceMacSummary }) => {
    const recent = isRecent(item.last_seen);
    
    return (
      <Pressable style={[styles.card, recent && styles.cardRecent]} onPress={() => viewDevice(item.mac_address)}>
        <View style={styles.cardHeader}>
          <View style={[styles.iconCircle, recent && styles.iconCircleRecent]}>
            <Ionicons name="bluetooth" size={18} color={recent ? "#4cd964" : "#5cd6ff"} />
          </View>
          <View style={styles.cardInfo}>
            <Text style={[styles.mac, { fontFamily: MONO }]}>{item.mac_address}</Text>
            <Text style={[styles.timeAgo, recent && styles.timeAgoRecent]}>
              {recent && "● "}{getTimeAgo(item.last_seen)}
            </Text>
          </View>
          
          {/* Quick actions */}
          <Pressable style={styles.mapBtn} onPress={() => viewOnMap(item.mac_address)}>
            <Ionicons name="map-outline" size={18} color="#5cd6ff" />
          </Pressable>
          <Ionicons name="chevron-forward" size={18} color="#7f8a99" />
        </View>

        <View style={styles.cardStats}>
          <View style={styles.stat}>
            <Ionicons name="radio-outline" size={12} color="#7f8a99" />
            <Text style={styles.statText}>{item.detection_count} detections</Text>
          </View>
          <View style={styles.stat}>
            <Ionicons name="calendar-outline" size={12} color="#7f8a99" />
            <Text style={styles.statText}>Since {new Date(item.first_seen).toLocaleDateString()}</Text>
          </View>
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.divider} />

      {/* Stats Header */}
      {!loading && !error && devices.length > 0 && (
        <View style={styles.statsHeader}>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{devices.length}</Text>
            <Text style={styles.statLabel}>Devices</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statNum}>{totalDetections}</Text>
            <Text style={styles.statLabel}>Detections</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statNum, recentCount > 0 && styles.statNumRecent]}>{recentCount}</Text>
            <Text style={styles.statLabel}>Recent</Text>
          </View>
        </View>
      )}

      {/* Filter Toggle */}
      <View style={styles.filterRow}>
        <Pressable 
          style={[styles.filterBtn, !showRecentOnly && styles.filterBtnActive]}
          onPress={() => setShowRecentOnly(false)}
        >
          <Ionicons name="list" size={14} color={!showRecentOnly ? "#0b1420" : "#5cd6ff"} />
          <Text style={[styles.filterText, !showRecentOnly && styles.filterTextActive]}>All</Text>
        </Pressable>
        <Pressable 
          style={[styles.filterBtn, showRecentOnly && styles.filterBtnActive]}
          onPress={() => setShowRecentOnly(true)}
        >
          <Ionicons name="time" size={14} color={showRecentOnly ? "#0b1420" : "#5cd6ff"} />
          <Text style={[styles.filterText, showRecentOnly && styles.filterTextActive]}>Recent</Text>
          {recentCount > 0 && (
            <View style={styles.filterBadge}>
              <Text style={styles.filterBadgeText}>{recentCount}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Results count + auto-refresh indicator */}
      {!loading && !error && (
        <View style={styles.resultsRow}>
          <Text style={styles.resultsText}>
            {displayedDevices.length} device{displayedDevices.length !== 1 ? "s" : ""}
          </Text>
          {showRecentOnly && (
            <View style={styles.autoRefresh}>
              <View style={styles.pulseDot} />
              <Text style={styles.autoRefreshText}>Auto-refresh</Text>
            </View>
          )}
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#5cd6ff" />
        </View>
      ) : error ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle" size={48} color="#ff6b6b" />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={loadDevices}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      ) : displayedDevices.length === 0 ? (
        <View style={styles.centered}>
          <Ionicons name={showRecentOnly ? "time-outline" : "bluetooth-outline"} size={56} color="#3a4b5c" />
          <Text style={styles.emptyTitle}>
            {showRecentOnly ? "No Recent Devices" : "No Devices Yet"}
          </Text>
          <Text style={styles.emptySubtitle}>
            {showRecentOnly 
              ? "No devices detected in the last 10 minutes" 
              : "Go to Detections tab and connect your BluStick"}
          </Text>
          {showRecentOnly && (
            <Pressable style={styles.retryBtn} onPress={() => setShowRecentOnly(false)}>
              <Text style={styles.retryText}>Show All</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <FlatList
          data={displayedDevices}
          keyExtractor={(item) => item.mac_address}
          renderItem={renderDevice}
          contentContainerStyle={styles.list}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          refreshControl={
            <RefreshControl 
              refreshing={refreshing} 
              onRefresh={() => { setRefreshing(true); loadDevices(); }} 
              tintColor="#5cd6ff" 
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  divider: { height: 1, backgroundColor: "rgba(92,214,255,0.12)" },

  // Stats Header
  statsHeader: { flexDirection: "row", justifyContent: "space-around", margin: 12, padding: 12, backgroundColor: "rgba(18,28,44,0.8)", borderRadius: 10, borderWidth: 1, borderColor: "rgba(92,214,255,0.15)" },
  statBox: { alignItems: "center" },
  statNum: { color: "#5cd6ff", fontSize: 20, fontWeight: "800" },
  statNumRecent: { color: "#4cd964" },
  statLabel: { color: "#7f8a99", fontSize: 11, marginTop: 2 },

  // Filter Row
  filterRow: { flexDirection: "row", paddingHorizontal: 12, gap: 10, marginBottom: 8 },
  filterBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)", backgroundColor: "rgba(92,214,255,0.08)" },
  filterBtnActive: { backgroundColor: "#5cd6ff", borderColor: "#5cd6ff" },
  filterText: { color: "#5cd6ff", fontSize: 13, fontWeight: "600" },
  filterTextActive: { color: "#0b1420", fontWeight: "700" },
  filterBadge: { backgroundColor: "#4cd964", paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 },
  filterBadgeText: { color: "#fff", fontSize: 10, fontWeight: "700" },

  // Results Row
  resultsRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 14, paddingBottom: 6 },
  resultsText: { color: "#7f8a99", fontSize: 12 },
  autoRefresh: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: "rgba(92,214,255,0.1)", borderRadius: 10 },
  pulseDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#5cd6ff" },
  autoRefreshText: { color: "#5cd6ff", fontSize: 10 },

  // List
  list: { padding: 12 },

  // Card
  card: { backgroundColor: "rgba(18,28,44,0.9)", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "rgba(92,214,255,0.15)" },
  cardRecent: { borderColor: "rgba(76,217,100,0.4)", borderLeftWidth: 3, borderLeftColor: "#4cd964" },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  iconCircle: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(92,214,255,0.1)", alignItems: "center", justifyContent: "center" },
  iconCircleRecent: { backgroundColor: "rgba(76,217,100,0.15)" },
  cardInfo: { flex: 1 },
  mac: { color: "#e6edf5", fontSize: 14, fontWeight: "700" },
  timeAgo: { color: "#7f8a99", fontSize: 11, marginTop: 2 },
  timeAgoRecent: { color: "#4cd964" },
  mapBtn: { padding: 8, borderRadius: 6, backgroundColor: "rgba(92,214,255,0.1)" },
  cardStats: { flexDirection: "row", gap: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: "rgba(92,214,255,0.1)" },
  stat: { flexDirection: "row", alignItems: "center", gap: 5 },
  statText: { color: "#9aa4b2", fontSize: 11 },

  // States
  centered: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, padding: 24 },
  errorText: { color: "#ff6b6b", fontSize: 13, textAlign: "center" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "rgba(92,214,255,0.1)", borderRadius: 8, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)", marginTop: 8 },
  retryText: { color: "#5cd6ff", fontWeight: "600" },
  emptyTitle: { color: "#e6edf5", fontSize: 17, fontWeight: "700" },
  emptySubtitle: { color: "#7f8a99", fontSize: 13, textAlign: "center" },
});