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
        // center map on user
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

    // ✅ call getDetections with ONLY the supported properties
    const data = await getDetections({
      limit: 200,
      // if later you add event filtering, you can also pass: event_id: someEventId
    });

    // ✅ filter by MAC on the client side if one is provided
    const filtered = macAddress
      ? data.filter((d) => d.mac_address === macAddress)
      : data;

    const withCoords = filtered.filter(
      (d) => d.latitude != null && d.longitude != null
    );

    if (withCoords.length > 0 && !userLocation) {
      // use the first detection to center the map
      setRegion({
        latitude: withCoords[0].latitude as number,
        longitude: withCoords[0].longitude as number,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      });
    }

    setDetections(filtered);
  } catch (e: any) {
    console.warn("[Map] Error loading detections:", e);
  } finally {
    setLoading(false);
    setRefreshing(false);
  }
};


  // initial load
  useEffect(() => {
    requestLocationPermission();
    console.log("[Map] Initial mount with MAC:", activeMacAddress);
    loadDetections(activeMacAddress);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // react to MAC changes (e.g., from Detections -> Map navigation)
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

  const shouldShowCircles = activeMacAddress !== undefined;

  const detectionsWithCoords = detections.filter(
    (d) => d.latitude != null && d.longitude != null
  );

  // sort newest -> oldest
  const sortedByTime = [...detectionsWithCoords].sort(
    (a, b) =>
      new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime()
  );
  const mostRecentDetection = sortedByTime[0];

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
              : "Select a device from Detections to view its route"}
          </Text>
        </View>
      </View>

      <View style={s.buttonRow}>
        <Pressable onPress={centerOnUser} style={s.locationBtn}>
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
          {/* Only show detections when a MAC address is selected */}
          {shouldShowCircles &&
            detectionsWithCoords.map((d, index) => {
              const isMostRecent =
                mostRecentDetection &&
                d.detected_at === mostRecentDetection.detected_at &&
                d.latitude === mostRecentDetection.latitude &&
                d.longitude === mostRecentDetection.longitude;

              const strokeColor = isMostRecent
                ? "rgba(0,255,170,0.95)" // most recent: bright green/cyan
                : "rgba(35,184,240,0.9)"; // older: blue

              const fillColor = isMostRecent
                ? "rgba(0,255,170,0.3)"
                : "rgba(35,184,240,0.25)";

              const uniqueKey = `circle-${
                d.blustick_id ?? d.mac_address ?? "no-id"
              }-${d.detected_at}-${d.latitude}-${d.longitude}-${index}`;

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

      <View style={s.legend}>
        <Text style={s.legendTitle}>Legend</Text>
        <View style={s.legendRow}>
          <View
            style={[
              s.legendDot,
              { backgroundColor: "rgba(0,255,170,0.9)" },
            ]}
          />
          <Text style={s.legendText}>Most recent detection</Text>
        </View>
        <View style={s.legendRow}>
          <View
            style={[
              s.legendDot,
              { backgroundColor: "rgba(35,184,240,0.9)" },
            ]}
          />
          <Text style={s.legendText}>Previous detections</Text>
        </View>
      </View>
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

// Dark theme style to match BluStick UI
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
