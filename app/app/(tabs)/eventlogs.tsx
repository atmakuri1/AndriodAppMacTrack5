// app/(tabs)/eventlogs.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Platform,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { getDeviceMacSummaries, DeviceMacSummary } from "../../api";

const mono = Platform.select({ ios: "Menlo", android: "monospace" }) as any;

export default function EventLogsScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<DeviceMacSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRows = async () => {
    try {
      setError(null);
      if (!refreshing) setLoading(true);

      const data = await getDeviceMacSummaries();
      // Sort by detection_count descending (most detected first)
      const sorted = data.sort((a, b) => b.detection_count - a.detection_count);
      setRows(sorted);
    } catch (e: any) {
      console.error("[EventLogs] failed:", e);
      setError(e?.message || "Failed to load device logs");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadRows();
  }, []);

  const refresh = () => {
    setRefreshing(true);
    loadRows();
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerLine} />

      {loading ? (
        <View style={s.centerContainer}>
          <ActivityIndicator size="large" color="#5cd6ff" />
        </View>
      ) : error ? (
        <View style={s.centerContainer}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      ) : rows.length === 0 ? (
        <View style={s.centerContainer}>
          <Text style={s.emptyText}>No devices detected yet.</Text>
        </View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.mac_address}
          refreshControl={
            <RefreshControl 
              refreshing={refreshing} 
              onRefresh={refresh}
              tintColor="#5cd6ff"
            />
          }
          contentContainerStyle={s.listContent}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={s.card}
              onPress={() =>
                router.push({
                  pathname: "/(tabs)/map",
                  params: { mac: item.mac_address },
                })
              }
              activeOpacity={0.7}
            >
              <Text style={s.macAddress}>{item.mac_address}</Text>

              <Text style={s.detectionCount}>
                {item.detection_count} detection
                {item.detection_count === 1 ? "" : "s"}
              </Text>

              <View style={s.timestampRow}>
                <View style={s.timestampCol}>
                  <Text style={s.timestampLabel}>First seen</Text>
                  <Text style={s.timestampValue} numberOfLines={1}>
                    {new Date(item.first_seen).toLocaleString()}
                  </Text>
                </View>
                <View style={s.timestampCol}>
                  <Text style={s.timestampLabel}>Last seen</Text>
                  <Text style={s.timestampValue} numberOfLines={1}>
                    {new Date(item.last_seen).toLocaleString()}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0b1420",
  },
  headerLine: {
    height: 1,
    backgroundColor: "rgba(92,214,255,0.12)",
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  errorText: {
    color: "#ff6b6b",
    textAlign: "center",
    fontSize: 14,
  },
  emptyText: {
    color: "#9aa4b2",
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    paddingTop: 16,
  },
  card: {
    marginBottom: 12,
    padding: 14,
    borderRadius: 10,
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
  },
  macAddress: {
    color: "#e6edf5",
    fontSize: 15,
    fontWeight: "700",
    fontFamily: mono,
    marginBottom: 8,
  },
  detectionCount: {
    color: "#5cd6ff",
    fontSize: 13,
    marginBottom: 10,
  },
  timestampRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 8,
  },
  timestampCol: {
    flex: 1,
  },
  timestampLabel: {
    color: "#7a8a9e",
    fontSize: 11,
    marginBottom: 3,
  },
  timestampValue: {
    color: "#c9d5e3",
    fontSize: 12,
  },
});