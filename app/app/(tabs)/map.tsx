// app/app/(tabs)/map.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, {
  Circle,
  PROVIDER_GOOGLE,
  Region,
} from "react-native-maps";
import { getDetections, DetectionRow } from "../../api";

const DEFAULT_CENTER: Region = {
  latitude: 30.622492,
  longitude: -96.340586,
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};

export default function MapScreen() {
  const [region, setRegion] = useState<Region>(DEFAULT_CENTER);
  const [detections, setDetections] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadDetections = async () => {
    try {
      if (!refreshing) setLoading(true);
      const data = await getDetections({ limit: 200 });
      setDetections(data);
    } catch (e: any) {
      console.warn(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadDetections();
  }, []);

  const onRefreshPress = () => {
    setRefreshing(true);
    loadDetections();
  };

  // turn estimated_distance (or fallback) into a visible radius in meters
  const getRadius = (d: DetectionRow) => {
    const base = d.estimated_distance ?? 50; // if DB has meters, keep it; tweak as needed
    // enforce a minimum size so circle is visible
    return Math.max(40, base * 5); // you can adjust the *5 factor if you want bigger/smaller zones
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerLine} />

      <View style={s.topBar}>
        <View>
          <Text style={s.title}>Live Detections</Text>
          <Text style={s.subtitle}>
            Blue zones show approximate areas of possible POIs.
          </Text>
        </View>

        <Pressable
          onPress={onRefreshPress}
          style={[s.refreshBtn, refreshing && { opacity: 0.6 }]}
          disabled={refreshing}
        >
          <Text style={s.refreshText}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Text>
        </Pressable>
      </View>

      <View style={s.mapContainer}>
        <MapView
          style={s.map}
          provider={PROVIDER_GOOGLE}
          initialRegion={region}
          onRegionChangeComplete={setRegion}
          customMapStyle={darkMapStyle}
        >
          {/* Translucent blue POI zones */}
          {detections
            .filter((d) => d.latitude != null && d.longitude != null)
            .map((d) => (
              <Circle
                key={`${d.blustick_id}-${d.detected_at}`}
                center={{
                  latitude: d.latitude as number,
                  longitude: d.longitude as number,
                }}
                radius={getRadius(d)} // meters
                strokeColor="rgba(35,184,240,0.9)"   // bright edge
                strokeWidth={2}
                fillColor="rgba(35,184,240,0.25)"    // translucent blue fill
              />
            ))}
        </MapView>

        {loading && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="large" color="#5cd6ff" />
            <Text style={s.loadingText}>Loading detections…</Text>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  headerLine: { height: 1, backgroundColor: "rgba(92,214,255,0.12)" },

  topBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  title: { color: "#23b8f0", fontSize: 18, fontWeight: "800" },
  subtitle: { color: "#9aa4b2", fontSize: 12, marginTop: 2 },

  refreshBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.6)",
    backgroundColor: "rgba(12,24,40,0.9)",
  },
  refreshText: { color: "#5cd6ff", fontSize: 12, fontWeight: "600" },

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
