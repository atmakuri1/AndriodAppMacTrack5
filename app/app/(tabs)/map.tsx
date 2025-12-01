// app/(tabs)/map.tsx
import React, { useEffect, useState, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, {
  Circle,
  PROVIDER_GOOGLE,
  Region,
  Polyline,
  Marker,
} from "react-native-maps";
import * as Location from "expo-location";
import { useLocalSearchParams, router } from "expo-router";
import { getDetections, DetectionRow } from "../../api";

const DEFAULT_CENTER: Region = {
  latitude: 30.622492,
  longitude: -96.340586,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// Visualization modes
type VizMode = "path" | "bubbles";

// Time filter options (data is recent, max ~10 min old)
type TimeFilter = "1m" | "2m" | "5m" | "10m" | "all";

const TIME_FILTERS: { key: TimeFilter; label: string; minutes: number | null }[] = [
  { key: "1m", label: "1m", minutes: 1 },
  { key: "2m", label: "2m", minutes: 2 },
  { key: "5m", label: "5m", minutes: 5 },
  { key: "10m", label: "10m", minutes: 10 },
  { key: "all", label: "All", minutes: null },
];

const VIZ_MODES: { key: VizMode; label: string; icon: string }[] = [
  { key: "path", label: "Path", icon: "〰️" },
  { key: "bubbles", label: "Bubbles", icon: "◯" },
];

// Douglas-Peucker path simplification
function simplifyPath(
  points: { latitude: number; longitude: number }[],
  tolerance: number
): { latitude: number; longitude: number }[] {
  if (points.length <= 2) return points;

  const sqDist = (
    p: { latitude: number; longitude: number },
    a: { latitude: number; longitude: number },
    b: { latitude: number; longitude: number }
  ) => {
    const dx = b.longitude - a.longitude;
    const dy = b.latitude - a.latitude;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p.longitude - a.longitude) * dx + (p.latitude - a.latitude) * dy) /
          (dx * dx + dy * dy)
      )
    );
    const projX = a.longitude + t * dx;
    const projY = a.latitude + t * dy;
    return (p.longitude - projX) ** 2 + (p.latitude - projY) ** 2;
  };

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = sqDist(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance * tolerance) {
    const left = simplifyPath(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyPath(points.slice(maxIdx), tolerance);
    return [...left.slice(0, -1), ...right];
  }

  return [first, last];
}

export default function MapScreen() {
  const { mac: macFromParams } = useLocalSearchParams<{ mac?: string }>();
  const mapRef = useRef<MapView>(null);

  const [region, setRegion] = useState<Region>(DEFAULT_CENTER);
  const [allDetections, setAllDetections] = useState<DetectionRow[]>([]);
  const [recentDevices, setRecentDevices] = useState<
    { mac: string; count: number; lastSeen: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locationPermission, setLocationPermission] = useState(false);
  const [activeMacAddress, setActiveMacAddress] = useState<string | undefined>(
    macFromParams ? String(macFromParams) : undefined
  );

  // Visualization state
  const [vizMode, setVizMode] = useState<VizMode>("path");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [showConfidence, setShowConfidence] = useState(false);

  const hasSelectedDevice = !!activeMacAddress;

  // Filter detections by time
  const filteredDetections = useMemo(() => {
    const filterConfig = TIME_FILTERS.find((f) => f.key === timeFilter);
    if (!filterConfig?.minutes) return allDetections;

    const cutoff = Date.now() - filterConfig.minutes * 60 * 1000;
    return allDetections.filter(
      (d) => d.detected_at && new Date(d.detected_at!).getTime() > cutoff
    );
  }, [allDetections, timeFilter]);

  const detectionsWithCoords = useMemo(
    () => filteredDetections.filter((d) => d.latitude != null && d.longitude != null),
    [filteredDetections]
  );

  // Sorted detections
  const sortedByTimeDesc = useMemo(
    () =>
      [...detectionsWithCoords].sort((a, b) => {
        const timeA = a.detected_at ? new Date(a.detected_at!).getTime() : 0;
        const timeB = b.detected_at ? new Date(b.detected_at!).getTime() : 0;
        return timeB - timeA;
      }),
    [detectionsWithCoords]
  );

  const sortedByTimeAsc = useMemo(
    () => [...sortedByTimeDesc].reverse(),
    [sortedByTimeDesc]
  );
  const mostRecentDetection = sortedByTimeDesc[0];

  // Simplified path for performance
  const simplifiedPath = useMemo(() => {
    const coords = sortedByTimeAsc.map((d) => ({
      latitude: d.latitude as number,
      longitude: d.longitude as number,
    }));
    // Adjust tolerance based on point count
    const tolerance = coords.length > 100 ? 0.0001 : 0.00005;
    return simplifyPath(coords, tolerance);
  }, [sortedByTimeAsc]);

  // Distance-based path segments (colored by YOUR distance from each point)
  const distanceSegments = useMemo(() => {
    if (!showConfidence || sortedByTimeAsc.length < 2 || !userLocation) return [];

    // Calculate distance from user to each detection point
    const getDistanceToUser = (lat: number, lng: number): number => {
      const R = 6371000; // Earth's radius in meters
      const dLat = ((userLocation.latitude - lat) * Math.PI) / 180;
      const dLon = ((userLocation.longitude - lng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((lat * Math.PI) / 180) *
          Math.cos((userLocation.latitude * Math.PI) / 180) *
          Math.sin(dLon / 2) *
          Math.sin(dLon / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c; // Distance in meters
    };

    // Find min/max distances for normalization
    const distances = sortedByTimeAsc.map((d) =>
      getDistanceToUser(d.latitude as number, d.longitude as number)
    );
    const minDist = Math.min(...distances);
    const maxDist = Math.max(...distances);
    const range = maxDist - minDist || 1; // Avoid division by zero

    const segments: {
      coords: { latitude: number; longitude: number }[];
      color: string;
    }[] = [];

    for (let i = 0; i < sortedByTimeAsc.length - 1; i++) {
      const a = sortedByTimeAsc[i];
      const b = sortedByTimeAsc[i + 1];

      // Get distance from user to midpoint of segment
      const midLat = ((a.latitude as number) + (b.latitude as number)) / 2;
      const midLng = ((a.longitude as number) + (b.longitude as number)) / 2;
      const distToUser = getDistanceToUser(midLat, midLng);

      // Normalize: 0 = closest (green), 1 = farthest (red)
      const normalized = (distToUser - minDist) / range;

      // Color: green (close) -> yellow -> red (far)
      let r, g, bCol;
      if (normalized < 0.5) {
        // Green to yellow (close to medium)
        r = Math.round(255 * (normalized * 2));
        g = 255;
        bCol = 50;
      } else {
        // Yellow to red (medium to far)
        r = 255;
        g = Math.round(255 * (1 - (normalized - 0.5) * 2));
        bCol = 50;
      }

      segments.push({
        coords: [
          { latitude: a.latitude as number, longitude: a.longitude as number },
          { latitude: b.latitude as number, longitude: b.longitude as number },
        ],
        color: `rgb(${r},${g},${bCol})`,
      });
    }

    return segments;
  }, [showConfidence, sortedByTimeAsc, userLocation]);

  const requestLocationPermission = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === "granted") {
        setLocationPermission(true);
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const coords = {
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
        };
        setUserLocation(coords);
        if (!activeMacAddress) {
          setRegion({ ...coords, latitudeDelta: 0.02, longitudeDelta: 0.02 });
        }
      }
    } catch (error) {
      console.warn("Error requesting location permission:", error);
    }
  };

  const loadRecentDevices = async () => {
    try {
      const data = await getDetections({ limit: 500 });
      const deviceMap = new Map<string, { count: number; lastSeen: string }>();

      data.forEach((d) => {
        if (!d.detected_at) return; // Skip if no timestamp

        const existing = deviceMap.get(d.mac_address);
        const nextCount = (existing?.count ?? 0) + 1;

        if (
          !existing ||
          new Date(d.detected_at!).getTime() >
            new Date(existing.lastSeen).getTime()
        ) {
          deviceMap.set(d.mac_address, {
            count: nextCount,
            lastSeen: d.detected_at!,
          });
        } else {
          deviceMap.set(d.mac_address, { ...existing, count: nextCount });
        }
      });

      const devices = Array.from(deviceMap.entries())
        .map(([mac, info]) => ({ mac, ...info }))
        .sort(
          (a, b) =>
            new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
        )
        .slice(0, 10);

      setRecentDevices(devices);
    } catch (e) {
      console.warn("Error loading recent devices:", e);
    }
  };

  const loadDetections = async (macAddress?: string) => {
    if (!macAddress) {
      setAllDetections([]);
      return;
    }

    try {
      if (!refreshing) setLoading(true);
      const data = await getDetections({ limit: 500 });
      const filtered = data.filter((d) => d.mac_address === macAddress);
      const withCoords = filtered.filter(
        (d) => d.latitude != null && d.longitude != null
      );

      if (withCoords.length > 0) {
        const lats = withCoords.map((d) => d.latitude as number);
        const lngs = withCoords.map((d) => d.longitude as number);
        const minLat = Math.min(...lats);
        const maxLat = Math.max(...lats);
        const minLng = Math.min(...lngs);
        const maxLng = Math.max(...lngs);

        setRegion({
          latitude: (minLat + maxLat) / 2,
          longitude: (minLng + maxLng) / 2,
          latitudeDelta: Math.max(0.005, (maxLat - minLat) * 1.5),
          longitudeDelta: Math.max(0.005, (maxLng - minLng) * 1.5),
        });
      }

      setAllDetections(filtered);
    } catch (e: unknown) {
      console.warn("[Map] Error loading detections:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    requestLocationPermission();
    loadRecentDevices();
    if (activeMacAddress) {
      loadDetections(activeMacAddress);
    }
  }, []);

  useEffect(() => {
    if (macFromParams) {
      const macStr = String(macFromParams);
      if (macStr !== activeMacAddress) {
        setActiveMacAddress(macStr);
        loadDetections(macStr);
      }
    }
  }, [macFromParams, activeMacAddress]);

  const selectDevice = (mac: string) => {
    setActiveMacAddress(mac);
    loadDetections(mac);
  };

  const clearDevice = () => {
    setActiveMacAddress(undefined);
    setAllDetections([]);
    if (userLocation) {
      setRegion({ ...userLocation, latitudeDelta: 0.02, longitudeDelta: 0.02 });
    }
  };

  const onRefresh = () => {
    setRefreshing(true);
    if (activeMacAddress) {
      loadDetections(activeMacAddress);
    } else {
      loadRecentDevices();
      setRefreshing(false);
    }
  };

  const centerOnUser = async () => {
    if (!locationPermission) {
      await requestLocationPermission();
      return;
    }
    try {
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const coords = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };
      setUserLocation(coords);
      setRegion({ ...coords, latitudeDelta: 0.01, longitudeDelta: 0.01 });
    } catch (error) {
      console.warn("Error getting location:", error);
    }
  };

  const formatMac = (mac: string) => {
    if (mac.length <= 11) return mac;
    return `${mac.slice(0, 5)}…${mac.slice(-5)}`;
  };

  const formatTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Text style={s.title}>{hasSelectedDevice ? "Tracking" : "Map"}</Text>
          {hasSelectedDevice && (
            <Pressable style={s.deviceChip} onPress={clearDevice}>
              <Text style={s.deviceChipText}>{formatMac(activeMacAddress!)}</Text>
              <Text style={s.deviceChipX}>✕</Text>
            </Pressable>
          )}
        </View>
        <View style={s.headerRight}>
          <Pressable style={s.headerBtn} onPress={centerOnUser}>
            <Text style={s.headerBtnIcon}>📍</Text>
          </Pressable>
          <Pressable
            style={[s.headerBtn, refreshing && s.headerBtnDisabled]}
            onPress={onRefresh}
            disabled={refreshing}
          >
            <Text style={s.headerBtnIcon}>{refreshing ? "⏳" : "↻"}</Text>
          </Pressable>
        </View>
      </View>

      {/* Controls when device selected */}
      {hasSelectedDevice && (
        <View style={s.controls}>
          {/* Viz mode selector */}
          <View style={s.vizModeRow}>
            {VIZ_MODES.map((mode) => (
              <Pressable
                key={mode.key}
                style={[s.vizModeBtn, vizMode === mode.key && s.vizModeBtnActive]}
                onPress={() => setVizMode(mode.key)}
              >
                <Text style={s.vizModeIcon}>{mode.icon}</Text>
                <Text
                  style={[
                    s.vizModeLabel,
                    vizMode === mode.key && s.vizModeLabelActive,
                  ]}
                >
                  {mode.label}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* Time filter */}
          <View style={s.timeFilterRow}>
            {TIME_FILTERS.map((filter) => (
              <Pressable
                key={filter.key}
                style={[s.timeBtn, timeFilter === filter.key && s.timeBtnActive]}
                onPress={() => setTimeFilter(filter.key)}
              >
                <Text
                  style={[
                    s.timeBtnText,
                    timeFilter === filter.key && s.timeBtnTextActive,
                  ]}
                >
                  {filter.label}
                </Text>
              </Pressable>
            ))}

            {/* Confidence toggle for path mode */}
            {vizMode === "path" && (
              <Pressable
                style={[s.confidenceBtn, showConfidence && s.confidenceBtnActive]}
                onPress={() => setShowConfidence(!showConfidence)}
              >
                <Text style={s.confidenceBtnText}>🎨</Text>
              </Pressable>
            )}
          </View>

          {/* Stats bar */}
          <View style={s.statsBar}>
            <Text style={s.statText}>
              {detectionsWithCoords.length} points
              {timeFilter !== "all" && ` (${timeFilter})`}
            </Text>
            {vizMode === "path" && (
              <Text style={s.statText}>Path: {simplifiedPath.length} segments</Text>
            )}
          </View>
        </View>
      )}

      {/* Map */}
      <View style={s.mapContainer}>
        <MapView
          ref={mapRef}
          style={s.map}
          provider={PROVIDER_GOOGLE}
          region={region}
          onRegionChangeComplete={setRegion}
          customMapStyle={darkMapStyle}
          showsUserLocation={locationPermission}
          showsMyLocationButton={false}
        >
          {/* PATH MODE */}
          {hasSelectedDevice &&
            vizMode === "path" &&
            !showConfidence &&
            simplifiedPath.length >= 2 && (
              <Polyline
                coordinates={simplifiedPath}
                strokeColor="#23b8f0"
                strokeWidth={3}
              />
            )}

          {/* PATH MODE - Distance-based colors (from YOUR location) */}
          {hasSelectedDevice &&
            vizMode === "path" &&
            showConfidence &&
            distanceSegments.map((seg, idx) => (
              <Polyline
                key={`dist-${idx}`}
                coordinates={seg.coords}
                strokeColor={seg.color}
                strokeWidth={4}
              />
            ))}

          {/* Start/End markers for path */}
          {hasSelectedDevice &&
            vizMode === "path" &&
            simplifiedPath.length >= 2 && (
              <>
                <Marker
                  coordinate={simplifiedPath[0]}
                  anchor={{ x: 0.5, y: 0.5 }}
                >
                  <View style={s.startMarker}>
                    <Text style={s.markerText}>S</Text>
                  </View>
                </Marker>
                <Marker
                  coordinate={simplifiedPath[simplifiedPath.length - 1]}
                  anchor={{ x: 0.5, y: 0.5 }}
                >
                  <View style={s.endMarker}>
                    <View style={s.endMarkerInner} />
                  </View>
                </Marker>
              </>
            )}

          {/* BUBBLES MODE */}
          {hasSelectedDevice &&
            vizMode === "bubbles" &&
            detectionsWithCoords.slice(0, 50).map((d, idx) => {
              const isMostRecent = d === mostRecentDetection;
              const radius = Math.max(20, (d.estimated_distance ?? 30) * 2);
              return (
                <Circle
                  key={`bubble-${idx}`}
                  center={{
                    latitude: d.latitude as number,
                    longitude: d.longitude as number,
                  }}
                  radius={radius}
                  strokeColor={isMostRecent ? "#00ffaa" : "rgba(35,184,240,0.6)"}
                  strokeWidth={isMostRecent ? 3 : 1}
                  fillColor={
                    isMostRecent
                      ? "rgba(0,255,170,0.25)"
                      : "rgba(35,184,240,0.1)"
                  }
                />
              );
            })}

          {/* Bubble mode warning if too many points */}
          {hasSelectedDevice &&
            vizMode === "bubbles" &&
            detectionsWithCoords.length > 50 && (
              <Marker
                coordinate={{
                  latitude: region.latitude + region.latitudeDelta * 0.35,
                  longitude: region.longitude,
                }}
                anchor={{ x: 0.5, y: 0.5 }}
              >
                <View style={s.warningBadge}>
                  <Text style={s.warningText}>
                    Showing 50/{detectionsWithCoords.length}
                  </Text>
                </View>
              </Marker>
            )}
        </MapView>

        {loading && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="large" color="#23b8f0" />
          </View>
        )}

        {/* Empty state overlay - shows device picker */}
        {!hasSelectedDevice && (
          <View style={s.devicePickerOverlay}>
            <View style={s.devicePicker}>
              <Text style={s.pickerTitle}>Select a Device</Text>
              <Text style={s.pickerSubtitle}>
                Choose from recent detections or go to the Detections tab
              </Text>

              {recentDevices.length > 0 ? (
                <ScrollView
                  style={s.deviceList}
                  showsVerticalScrollIndicator={false}
                >
                  {recentDevices.map((device) => (
                    <Pressable
                      key={device.mac}
                      style={s.deviceItem}
                      onPress={() => selectDevice(device.mac)}
                    >
                      <View style={s.deviceInfo}>
                        <Text style={s.deviceMac}>{device.mac}</Text>
                        <Text style={s.deviceMeta}>
                          {device.count} detections ·{" "}
                          {formatTimeAgo(device.lastSeen)}
                        </Text>
                      </View>
                      <Text style={s.deviceArrow}>→</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <View style={s.noDevices}>
                  <Text style={s.noDevicesText}>No recent devices found</Text>
                </View>
              )}

              <Pressable
                style={s.goToDetectionsBtn}
                onPress={() => router.push("/(tabs)/detections")}
              >
                <Text style={s.goToDetectionsText}>Browse All Detections</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>

      {/* Distance legend */}
      {hasSelectedDevice &&
        vizMode === "path" &&
        showConfidence &&
        userLocation && (
          <View style={s.legend}>
            <Text style={s.legendLabel}>Distance from You</Text>
            <View style={s.legendGradient}>
              <View style={[s.legendStop, { backgroundColor: "#00ff50" }]} />
              <View style={[s.legendStop, { backgroundColor: "#ffaa00" }]} />
              <View style={[s.legendStop, { backgroundColor: "#ff3232" }]} />
            </View>
            <View style={s.legendLabels}>
              <Text style={s.legendText}>Closest</Text>
              <Text style={s.legendText}>Farthest</Text>
            </View>
          </View>
        )}

      {/* Show hint if no location for distance mode */}
      {hasSelectedDevice &&
        vizMode === "path" &&
        showConfidence &&
        !userLocation && (
          <View style={s.legend}>
            <Text style={s.legendLabel}>
              📍 Enable location to see distance colors
            </Text>
          </View>
        )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#0a1018",
  },

  // Header
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(35,184,240,0.1)",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerRight: {
    flexDirection: "row",
    gap: 8,
  },
  title: {
    color: "#e6edf5",
    fontSize: 20,
    fontWeight: "700",
  },
  deviceChip: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(35,184,240,0.15)",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    gap: 6,
  },
  deviceChipText: {
    color: "#23b8f0",
    fontSize: 11,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  deviceChipX: {
    color: "#ff6b6b",
    fontSize: 12,
    fontWeight: "700",
  },
  headerBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(35,184,240,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  headerBtnDisabled: {
    opacity: 0.5,
  },
  headerBtnIcon: {
    fontSize: 16,
  },

  // Controls
  controls: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 8,
  },
  vizModeRow: {
    flexDirection: "row",
    gap: 6,
  },
  vizModeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  vizModeBtnActive: {
    backgroundColor: "rgba(35,184,240,0.2)",
    borderColor: "#23b8f0",
  },
  vizModeIcon: {
    fontSize: 14,
  },
  vizModeLabel: {
    color: "#6b7a8f",
    fontSize: 11,
    fontWeight: "600",
  },
  vizModeLabelActive: {
    color: "#23b8f0",
  },

  timeFilterRow: {
    flexDirection: "row",
    gap: 6,
  },
  timeBtn: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.03)",
    alignItems: "center",
  },
  timeBtnActive: {
    backgroundColor: "rgba(35,184,240,0.15)",
  },
  timeBtnText: {
    color: "#5a6577",
    fontSize: 11,
    fontWeight: "600",
  },
  timeBtnTextActive: {
    color: "#23b8f0",
  },
  confidenceBtn: {
    width: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
    backgroundColor: "rgba(255,255,255,0.03)",
  },
  confidenceBtnActive: {
    backgroundColor: "rgba(255,200,50,0.2)",
  },
  confidenceBtnText: {
    fontSize: 14,
  },

  statsBar: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  statText: {
    color: "#4a5568",
    fontSize: 10,
  },

  // Map
  mapContainer: {
    flex: 1,
    margin: 10,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(35,184,240,0.15)",
  },
  map: {
    flex: 1,
  },

  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,16,24,0.8)",
  },

  // Markers
  startMarker: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "#23b8f0",
    alignItems: "center",
    justifyContent: "center",
  },
  markerText: {
    color: "#fff",
    fontSize: 11,
    fontWeight: "700",
  },
  endMarker: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "rgba(0,255,170,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  endMarkerInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#00ffaa",
  },

  warningBadge: {
    backgroundColor: "rgba(255,170,0,0.9)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  warningText: {
    color: "#000",
    fontSize: 10,
    fontWeight: "600",
  },

  // Device picker overlay
  devicePickerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(10,16,24,0.85)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  devicePicker: {
    width: "100%",
    maxWidth: 340,
    maxHeight: "80%",
    backgroundColor: "#111a24",
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: "rgba(35,184,240,0.2)",
  },
  pickerTitle: {
    color: "#e6edf5",
    fontSize: 18,
    fontWeight: "700",
    marginBottom: 4,
  },
  pickerSubtitle: {
    color: "#5a6577",
    fontSize: 12,
    marginBottom: 16,
  },
  deviceList: {
    maxHeight: 280,
  },
  deviceItem: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    backgroundColor: "rgba(35,184,240,0.08)",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(35,184,240,0.15)",
  },
  deviceInfo: {
    flex: 1,
  },
  deviceMac: {
    color: "#e6edf5",
    fontSize: 13,
    fontWeight: "600",
    fontFamily: "monospace",
  },
  deviceMeta: {
    color: "#5a6577",
    fontSize: 10,
    marginTop: 2,
  },
  deviceArrow: {
    color: "#23b8f0",
    fontSize: 16,
    marginLeft: 10,
  },
  noDevices: {
    paddingVertical: 30,
    alignItems: "center",
  },
  noDevicesText: {
    color: "#5a6577",
    fontSize: 13,
  },
  goToDetectionsBtn: {
    marginTop: 16,
    paddingVertical: 12,
    backgroundColor: "#23b8f0",
    borderRadius: 10,
    alignItems: "center",
  },
  goToDetectionsText: {
    color: "#0a1018",
    fontSize: 14,
    fontWeight: "700",
  },

  // Legend
  legend: {
    marginHorizontal: 12,
    marginBottom: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "rgba(17,26,36,0.95)",
    borderWidth: 1,
    borderColor: "rgba(35,184,240,0.15)",
  },
  legendLabel: {
    color: "#8899aa",
    fontSize: 10,
    marginBottom: 6,
    textAlign: "center",
  },
  legendGradient: {
    flexDirection: "row",
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
  },
  legendStop: {
    flex: 1,
  },
  legendLabels: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  legendText: {
    color: "#5a6577",
    fontSize: 9,
  },
});

const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#1a2332" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#7a8a9a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a2332" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a3a4a" }] },
  {
    featureType: "road",
    elementType: "labels",
    stylers: [{ visibility: "simplified" }],
  },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0f1a28" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  {
    featureType: "administrative",
    elementType: "geometry",
    stylers: [{ visibility: "off" }],
  },
];
