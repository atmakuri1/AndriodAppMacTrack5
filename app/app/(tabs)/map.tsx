// app/(tabs)/map.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, {
  Circle,
  PROVIDER_GOOGLE,
  Region,
  Marker,
} from "react-native-maps";
import * as Location from "expo-location";
import { useLocalSearchParams } from "expo-router";
import { getDetections, DetectionRow } from "../../api";

const DEFAULT_CENTER: Region = {
  latitude: 30.622492,
  longitude: -96.340586,
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};

export default function MapScreen() {
  const { mac: macFromParams } = useLocalSearchParams<{ mac?: string }>();
  
  const [region, setRegion] = useState<Region>(DEFAULT_CENTER);
  const [detections, setDetections] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [userLocation, setUserLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locationPermission, setLocationPermission] = useState(false);
  const [activeMacAddress, setActiveMacAddress] = useState<string | undefined>(
    macFromParams ? String(macFromParams) : undefined
  );

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
        // Center map on user location
        setRegion({
          ...coords,
          latitudeDelta: 0.01,
          longitudeDelta: 0.01,
        });
      } else {
        Alert.alert(
          "Location Permission",
          "Location permission is needed to show your position on the map."
        );
      }
    } catch (error) {
      console.warn("Error requesting location permission:", error);
    }
  };

  const loadDetections = async (macAddress?: string) => {
    try {
      if (!refreshing) setLoading(true);
      console.log("[Map] Loading detections with MAC filter:", macAddress);
      
      const data = await getDetections({ 
        limit: 200,
        mac_address: macAddress || undefined,
      });
      
      console.log("[Map] Loaded", data.length, "detections");
      
      // Debug: Check how many have coordinates
      const withCoords = data.filter(d => d.latitude != null && d.longitude != null);
      console.log("[Map] Detections with coordinates:", withCoords.length);
      
      if (withCoords.length > 0) {
        console.log("[Map] Sample detection:", {
          mac: withCoords[0].mac_address,
          lat: withCoords[0].latitude,
          lng: withCoords[0].longitude,
          distance: withCoords[0].estimated_distance,
        });
      }
      
      setDetections(data);
    } catch (e: any) {
      console.warn("[Map] Error loading detections:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    requestLocationPermission();
    console.log("[Map] Initial mount with MAC:", activeMacAddress);
    loadDetections(activeMacAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch for MAC address changes from navigation
  useEffect(() => {
    if (macFromParams) {
      const macStr = String(macFromParams);
      console.log("[Map] MAC param changed to:", macStr);
      if (macStr !== activeMacAddress) {
        setActiveMacAddress(macStr);
        loadDetections(macStr);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [macFromParams]);

  const onRefreshPress = () => {
    setRefreshing(true);
    loadDetections(activeMacAddress);
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
      setRegion({
        ...coords,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      });
    } catch (error) {
      console.warn("Error getting location:", error);
    }
  };

  const clearFilter = () => {
    setActiveMacAddress(undefined);
    loadDetections(undefined);
  };

  // turn estimated_distance (or fallback) into a visible radius in meters
  const getRadius = (d: DetectionRow) => {
    const base = d.estimated_distance ?? 50;
    return Math.max(40, base * 5);
  };

  // Only show circles when a MAC address is selected
  const shouldShowCircles = activeMacAddress !== undefined;

  // Get detections with coordinates sorted by timestamp
  const detectionsWithCoords = detections.filter(
    (d) => d.latitude != null && d.longitude != null
  );

  // Sort by timestamp for most recent (descending order)
  const sortedByTime = [...detectionsWithCoords].sort(
    (a, b) =>
      new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime()
  );
  const mostRecentDetection = sortedByTime[0]; // First in descending sort is most recent
  
  console.log("[Map] Most recent detection:", mostRecentDetection?.detected_at);

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerLine} />

      <View style={s.topBar}>
        <View style={{ flex: 1 }}>
          <Text style={s.title}>Live Detections</Text>
          <Text style={s.subtitle}>
            {shouldShowCircles 
              ? `Showing ${detectionsWithCoords.length} detections for ${activeMacAddress}`
              : "Select a device from Event Logs to view detections"}
          </Text>
        </View>
      </View>

      <View style={s.buttonRow}>
        <Pressable
          onPress={centerOnUser}
          style={s.locationBtn}
        >
          <Text style={s.locationBtnText}>📍 My Location</Text>
        </Pressable>

        <Pressable
          onPress={onRefreshPress}
          style={[s.refreshBtn, refreshing && { opacity: 0.6 }]}
          disabled={refreshing}
        >
          <Text style={s.refreshText}>
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </Text>
        </Pressable>

        {activeMacAddress && (
          <Pressable onPress={clearFilter} style={s.clearBtn}>
            <Text style={s.clearText}>✕ Clear</Text>
          </Pressable>
        )}
      </View>

      <View style={s.mapContainer}>
        <MapView
          style={s.map}
          provider={PROVIDER_GOOGLE}
          region={region}
          onRegionChangeComplete={setRegion}
          customMapStyle={darkMapStyle}
          showsUserLocation={locationPermission}
          showsMyLocationButton={false}
        >
          {/* User location marker (custom) */}
          {userLocation && (
            <Marker
              coordinate={userLocation}
              title="You are here"
              pinColor="#5cd6ff"
            />
          )}

          {/* Detection circles - only show when MAC is selected */}
          {shouldShowCircles &&
            detectionsWithCoords.map((d, index) => {
              // Determine if this is most recent detection
              const isMostRecent = mostRecentDetection && 
                d.detected_at === mostRecentDetection.detected_at &&
                d.latitude === mostRecentDetection.latitude &&
                d.longitude === mostRecentDetection.longitude;

              // Color coding:
              // - Most recent detection: Bright Green/Cyan
              // - All others: Blue (default)
              const strokeColor = isMostRecent 
                ? "rgba(0,255,170,0.95)"  // Bright green/cyan for most recent
                : "rgba(35,184,240,0.9)"; // Blue for others
              
              const fillColor = isMostRecent
                ? "rgba(0,255,170,0.3)"
                : "rgba(35,184,240,0.25)";

              // Create unique key using multiple fields to avoid collisions
              const uniqueKey = `circle-${d.blustick_id || 'no-id'}-${d.mac_address || 'no-mac'}-${d.detected_at}-${d.latitude}-${d.longitude}-${index}`;

              return (
                <Circle
                  key={uniqueKey}
                  center={{
                    latitude: d.latitude as number,
                    longitude: d.longitude as number,
                  }}
                  radius={getRadius(d)}
                  strokeColor={strokeColor}
                  strokeWidth={2}
                  fillColor={fillColor}
                />
              );
            })}
        </MapView>

        {loading && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="large" color="#5cd6ff" />
            <Text style={s.loadingText}>Loading detections…</Text>
          </View>
        )}
      </View>

      {/* Legend */}
      {shouldShowCircles && detectionsWithCoords.length > 0 && (
        <View style={s.legend}>
          <Text style={s.legendTitle}>Legend</Text>
          <View style={s.legendRow}>
            <View style={[s.legendDot, { backgroundColor: "rgba(0,255,170,0.95))" }]} />
            <Text style={s.legendText}>Most recent detection</Text>
          </View>
          <View style={s.legendRow}>
            <View style={[s.legendDot, { backgroundColor: "rgba(35,184,240,0.9)" }]} />
            <Text style={s.legendText}>Other detections</Text>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  headerLine: { height: 1, backgroundColor: "rgba(92,214,255,0.12)" },

  topBar: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 8,
  },
  title: { color: "#23b8f0", fontSize: 18, fontWeight: "800" },
  subtitle: { color: "#9aa4b2", fontSize: 12, marginTop: 2 },

  buttonRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },

  locationBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.4)",
    backgroundColor: "rgba(35,184,240,0.1)",
    alignItems: "center",
  },

  locationBtnText: {
    color: "#5cd6ff",
    fontSize: 13,
    fontWeight: "600",
  },

  refreshBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.4)",
    backgroundColor: "rgba(35,184,240,0.08)",
    alignItems: "center",
  },
  refreshText: { color: "#5cd6ff", fontSize: 13, fontWeight: "600" },

  clearBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(255,107,107,0.6)",
    backgroundColor: "rgba(255,107,107,0.1)",
    alignItems: "center",
  },
  clearText: { color: "#ff6b6b", fontSize: 13, fontWeight: "600" },

  mapContainer: {
    flex: 1,
    overflow: "hidden",
    borderRadius: 16,
    marginHorizontal: 12,
    marginBottom: 12,
  },
  map: { flex: 1 },

  loadingOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(5,10,20,0.45)",
  },
  loadingText: { color: "#e6edf5", marginTop: 8 },

  legend: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: 8,
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
  },
  legendTitle: {
    color: "#e6edf5",
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 8,
  },
  legendRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 4,
  },
  legendDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    marginRight: 8,
  },
  legendText: {
    color: "#c9d5e3",
    fontSize: 12,
  },
});

// Optional dark map style so it fits BluStick theme
const darkMapStyle = [
  { elementType: "geometry", stylers: [{ color: "#1b2838" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#e0ecff" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1b2838" }] },
  {
    featureType: "poi",
    elementType: "geometry",
    stylers: [{ color: "#182533" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#2a3b4c" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#122231" }],
  },
];