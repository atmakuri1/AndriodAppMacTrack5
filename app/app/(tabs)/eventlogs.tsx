// app/(tabs)/eventlogs.tsx - Enhanced version
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
  TextInput,
  Pressable,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { getDeviceMacSummaries, DeviceMacSummary } from "../../api";
import { Ionicons } from "@expo/vector-icons";

const mono = Platform.select({ ios: "Menlo", android: "monospace" }) as any;

// Time filter options
type TimeFilter = 'all' | 'hour' | 'day' | 'week';

// Header stats component
const HeaderStats = ({ 
  totalDevices, 
  totalDetections, 
  recentCount 
}: { 
  totalDevices: number; 
  totalDetections: number; 
  recentCount: number; 
}) => (
  <View style={s.headerStats}>
    <View style={s.statBadge}>
      <Ionicons name="hardware-chip" size={16} color="#5cd6ff" />
      <View>
        <Text style={s.statValue}>{totalDevices}</Text>
        <Text style={s.statLabel}>Devices</Text>
      </View>
    </View>
    <View style={s.statBadge}>
      <Ionicons name="radio" size={16} color="#5cd6ff" />
      <View>
        <Text style={s.statValue}>{totalDetections}</Text>
        <Text style={s.statLabel}>Detections</Text>
      </View>
    </View>
    <View style={s.statBadge}>
      <Ionicons name="time" size={16} color="#5cd6ff" />
      <View>
        <Text style={s.statValue}>{recentCount}</Text>
        <Text style={s.statLabel}>Recent</Text>
      </View>
    </View>
  </View>
);

// Filter chip component
const FilterChip = ({ 
  label, 
  active, 
  onPress,
  width = 90,
}: { 
  label: string; 
  active: boolean; 
  onPress: () => void;
  width?: number;
}) => (
  <Pressable 
    onPress={onPress} 
    style={[s.filterChip, active && s.filterChipActive, { width }]}
  >
    <Text style={[s.filterChipText, active && s.filterChipTextActive]}>
      {label}
    </Text>
  </Pressable>
);

// Empty state component
const EmptyState = () => (
  <View style={s.emptyState}>
    <Ionicons name="calendar-outline" size={64} color="#3a4b5c" />
    <Text style={s.emptyTitle}>No Devices Yet</Text>
    <Text style={s.emptySubtitle}>
      Start tracking by syncing your BluStick device
    </Text>
  </View>
);

// Loading skeleton
const SkeletonCard = () => (
  <View style={s.skeletonCard}>
    <View style={[s.skeleton, { width: 150, height: 16, marginBottom: 10 }]} />
    <View style={[s.skeleton, { width: 100, height: 12, marginBottom: 8 }]} />
    <View style={s.skeletonRow}>
      <View style={[s.skeleton, { width: 120, height: 12 }]} />
      <View style={[s.skeleton, { width: 120, height: 12 }]} />
    </View>
  </View>
);

export default function EventLogsScreen() {
  const router = useRouter();
  const [allRows, setAllRows] = useState<DeviceMacSummary[]>([]);
  const [filteredRows, setFilteredRows] = useState<DeviceMacSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');

  const loadRows = async () => {
    try {
      setError(null);
      if (!refreshing) setLoading(true);

      const data = await getDeviceMacSummaries();
      const sorted = data.sort((a, b) => {
        const timeA = new Date(a.last_seen).getTime();
        const timeB = new Date(b.last_seen).getTime();
        if (timeB !== timeA) {
          return timeB - timeA;
        }
        return b.detection_count - a.detection_count;
      });
      setAllRows(sorted);
      applyFilters(sorted, searchQuery, timeFilter);
    } catch (e: any) {
      console.error("[EventLogs] failed:", e);
      setError(e?.message || "Failed to load device logs");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const applyFilters = (
    data: DeviceMacSummary[], 
    search: string, 
    time: TimeFilter
  ) => {
    let filtered = [...data];

    // Apply search filter
    if (search.trim()) {
      const query = search.toLowerCase();
      filtered = filtered.filter(row => 
        row.mac_address.toLowerCase().includes(query)
      );
    }

    // Apply time filter
    if (time !== 'all') {
      const now = Date.now();
      const cutoff = {
        hour: now - 60 * 60 * 1000,
        day: now - 24 * 60 * 60 * 1000,
        week: now - 7 * 24 * 60 * 60 * 1000,
      }[time];

      filtered = filtered.filter(row => 
        new Date(row.last_seen).getTime() > cutoff
      );
    }

    setFilteredRows(filtered);
  };

  useEffect(() => {
    loadRows();
  }, []);

  useEffect(() => {
    applyFilters(allRows, searchQuery, timeFilter);
  }, [searchQuery, timeFilter, allRows]);

  const refresh = () => {
    setRefreshing(true);
    loadRows();
  };

  const handleTimeFilter = (filter: TimeFilter) => {
    setTimeFilter(filter);
  };

  const clearSearch = () => {
    setSearchQuery("");
  };

  // Calculate stats
  const totalDevices = allRows.length;
  const totalDetections = allRows.reduce((sum, row) => sum + row.detection_count, 0);
  const recentCount = allRows.filter(row => {
    const lastSeen = new Date(row.last_seen).getTime();
    const hourAgo = Date.now() - 60 * 60 * 1000;
    return lastSeen > hourAgo;
  }).length;

  // Calculate time ago
  const getTimeAgo = (dateString: string) => {
    const now = Date.now();
    const then = new Date(dateString).getTime();
    const diff = now - then;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    return `${days}d ago`;
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerLine} />

      {/* Header Stats */}
      {!loading && !error && allRows.length > 0 && (
        <HeaderStats 
          totalDevices={totalDevices}
          totalDetections={totalDetections}
          recentCount={recentCount}
        />
      )}

      {/* Search Bar */}
      <View style={s.searchContainer}>
        <View style={s.searchBar}>
          <Ionicons name="search" size={18} color="#9aa4b2" />
          <TextInput
            style={s.searchInput}
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search by MAC address..."
            placeholderTextColor="#9aa4b2"
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={clearSearch}>
              <Ionicons name="close-circle" size={18} color="#9aa4b2" />
            </Pressable>
          )}
        </View>
      </View>

      {/* Quick Filters */}
      <View style={s.filterChipsContainer}>
        <Pressable 
          onPress={() => handleTimeFilter('all')}
          style={[s.filterChip, timeFilter === 'all' && s.filterChipActive]}
        >
          <Text style={[s.filterChipText, timeFilter === 'all' && s.filterChipTextActive]}>
            All
          </Text>
        </Pressable>
        
        <Pressable 
          onPress={() => handleTimeFilter('hour')}
          style={[s.filterChip, timeFilter === 'hour' && s.filterChipActive]}
        >
          <Text style={[s.filterChipText, timeFilter === 'hour' && s.filterChipTextActive]}>
            Last Hour
          </Text>
        </Pressable>
        
        <Pressable 
          onPress={() => handleTimeFilter('day')}
          style={[s.filterChip, timeFilter === 'day' && s.filterChipActive]}
        >
          <Text style={[s.filterChipText, timeFilter === 'day' && s.filterChipTextActive]}>
            Today
          </Text>
        </Pressable>
        
        <Pressable 
          onPress={() => handleTimeFilter('week')}
          style={[s.filterChip, timeFilter === 'week' && s.filterChipActive]}
        >
          <Text style={[s.filterChipText, timeFilter === 'week' && s.filterChipTextActive]}>
            This Week
          </Text>
        </Pressable>
      </View>

      {/* Results Count */}
      {!loading && !error && (
        <View style={s.resultsBar}>
          <Text style={s.resultsText}>
            {filteredRows.length === allRows.length 
              ? `${filteredRows.length} device${filteredRows.length === 1 ? '' : 's'}`
              : `${filteredRows.length} of ${allRows.length} device${allRows.length === 1 ? '' : 's'}`
            }
          </Text>
        </View>
      )}

      {loading ? (
        <View style={s.listContent}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </View>
      ) : error ? (
        <View style={s.centerContainer}>
          <Ionicons name="alert-circle-outline" size={48} color="#ff6b6b" />
          <Text style={s.errorText}>{error}</Text>
          <Pressable onPress={refresh} style={s.retryBtn}>
            <Text style={s.retryText}>Try Again</Text>
          </Pressable>
        </View>
      ) : filteredRows.length === 0 ? (
        searchQuery || timeFilter !== 'all' ? (
          <View style={s.centerContainer}>
            <Ionicons name="filter-outline" size={48} color="#3a4b5c" />
            <Text style={s.emptyTitle}>No Results</Text>
            <Text style={s.emptySubtitle}>
              Try adjusting your filters
            </Text>
            <Pressable 
              onPress={() => {
                setSearchQuery("");
                setTimeFilter('all');
              }} 
              style={s.clearFiltersBtn}
            >
              <Text style={s.clearFiltersText}>Clear Filters</Text>
            </Pressable>
          </View>
        ) : (
          <EmptyState />
        )
      ) : (
        <FlatList
          data={filteredRows}
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
                  pathname: "/detections",
                  params: { mac: item.mac_address },
                })
              }
              activeOpacity={0.7}
            >
              {/* Card Header */}
              <View style={s.cardTop}>
                <View style={s.iconContainer}>
                  <Ionicons name="bluetooth" size={20} color="#5cd6ff" />
                </View>
                <View style={s.cardTopContent}>
                  <Text style={s.macAddress}>{item.mac_address}</Text>
                  <Text style={s.timeAgo}>{getTimeAgo(item.last_seen)}</Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#9aa4b2" />
              </View>

              {/* Stats Row */}
              <View style={s.statsRow}>
                <View style={s.statItem}>
                  <Ionicons name="radio-outline" size={14} color="#7a8a9e" />
                  <Text style={s.statText}>
                    {item.detection_count} detection{item.detection_count === 1 ? '' : 's'}
                  </Text>
                </View>
              </View>

              {/* Timestamps */}
              <View style={s.timestampRow}>
                <View style={s.timestampCol}>
                  <Text style={s.timestampLabel}>First seen</Text>
                  <Text style={s.timestampValue} numberOfLines={1}>
                    {new Date(item.first_seen).toLocaleDateString()}
                  </Text>
                </View>
                <View style={s.timestampDivider} />
                <View style={s.timestampCol}>
                  <Text style={s.timestampLabel}>Last seen</Text>
                  <Text style={s.timestampValue} numberOfLines={1}>
                    {new Date(item.last_seen).toLocaleDateString()}
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

  headerStats: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "rgba(18,28,44,0.6)",
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.15)",
  },

  statBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },

  statValue: {
    color: "#5cd6ff",
    fontSize: 18,
    fontWeight: "700",
  },

  statLabel: {
    color: "#9aa4b2",
    fontSize: 11,
  },

  searchContainer: {
    paddingHorizontal: 16,
    paddingTop: 12,
  },

  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f1a2a",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
  },

  searchInput: {
    flex: 1,
    color: "#e6edf5",
    fontSize: 14,
  },

  filterChipsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
    flexWrap: 'wrap', // Allow wrapping on small screens
  },

  filterChip: {
    flex: 1,
    minWidth: 70,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.3)",
    backgroundColor: "rgba(35,184,240,0.08)",
    alignItems: 'center',
    justifyContent: 'center',
  },

  filterChipActive: {
    backgroundColor: "#5cd6ff",
    borderColor: "#5cd6ff",
  },

  filterChipText: {
    color: "#5cd6ff",
    fontSize: 12,
    fontWeight: "600",
    textAlign: 'center',
  },

  filterChipTextActive: {
    color: "#0b1420",
    fontWeight: "700",
  },

  resultsBar: {
    paddingHorizontal: 16,
    paddingBottom: 8,
  },

  resultsText: {
    color: "#9aa4b2",
    fontSize: 12,
    fontWeight: "600",
  },

  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 12,
  },

  errorText: {
    color: "#ff6b6b",
    textAlign: "center",
    fontSize: 14,
  },

  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: "rgba(92,214,255,0.1)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.3)",
  },

  retryText: {
    color: "#5cd6ff",
    fontWeight: "600",
    fontSize: 14,
  },

  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
    gap: 12,
  },

  emptyTitle: {
    color: "#e6edf5",
    fontSize: 18,
    fontWeight: "700",
    marginTop: 8,
  },

  emptySubtitle: {
    color: "#9aa4b2",
    fontSize: 14,
    textAlign: "center",
  },

  clearFiltersBtn: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 10,
    backgroundColor: "rgba(92,214,255,0.1)",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.3)",
  },

  clearFiltersText: {
    color: "#5cd6ff",
    fontWeight: "600",
    fontSize: 14,
  },

  listContent: {
    paddingHorizontal: 16,
    paddingBottom: 24,
    paddingTop: 8,
  },

  card: {
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
  },

  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 12,
    gap: 12,
  },

  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(92,214,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },

  cardTopContent: {
    flex: 1,
  },

  macAddress: {
    color: "#e6edf5",
    fontSize: 15,
    fontWeight: "700",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) as any,
    marginBottom: 2,
  },

  timeAgo: {
    color: "#7a8a9e",
    fontSize: 12,
  },

  statsRow: {
    flexDirection: "row",
    gap: 16,
    marginBottom: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(92,214,255,0.1)",
  },

  statItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },

  statText: {
    color: "#9aa4b2",
    fontSize: 12,
  },

  timestampRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },

  timestampCol: {
    flex: 1,
  },

  timestampDivider: {
    width: 1,
    height: 24,
    backgroundColor: "rgba(92,214,255,0.15)",
  },

  timestampLabel: {
    color: "#7a8a9e",
    fontSize: 10,
    marginBottom: 3,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },

  timestampValue: {
    color: "#c9d5e3",
    fontSize: 12,
    fontWeight: "600",
  },

  skeletonCard: {
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
  },

  skeletonRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },

  skeleton: {
    backgroundColor: "rgba(92,214,255,0.1)",
    borderRadius: 4,
  },
});