// app/(tabs)/map.tsx
import React, { useEffect, useState, useMemo, useRef } from "react";
import { View, Text, StyleSheet, ActivityIndicator, Pressable, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import MapView, { Circle, PROVIDER_GOOGLE, Region, Polyline, Marker } from "react-native-maps";
import * as Location from "expo-location";
import { useLocalSearchParams, router } from "expo-router";
import { getDetections, DetectionRow } from "../../api";

const DEFAULT_REGION: Region = { latitude: 30.622492, longitude: -96.340586, latitudeDelta: 0.05, longitudeDelta: 0.05 };
type VizMode = "path" | "bubbles";
type TimeFilter = "1m" | "2m" | "5m" | "10m" | "all";

const TIME_FILTERS = [
  { key: "1m" as TimeFilter, label: "1m", minutes: 1 },
  { key: "2m" as TimeFilter, label: "2m", minutes: 2 },
  { key: "5m" as TimeFilter, label: "5m", minutes: 5 },
  { key: "10m" as TimeFilter, label: "10m", minutes: 10 },
  { key: "all" as TimeFilter, label: "All", minutes: null },
];

// Douglas-Peucker simplification
const simplifyPath = (points: { latitude: number; longitude: number }[], tol: number): typeof points => {
  if (points.length <= 2) return points;
  const sqDist = (p: typeof points[0], a: typeof points[0], b: typeof points[0]) => {
    const dx = b.longitude - a.longitude, dy = b.latitude - a.latitude;
    const t = Math.max(0, Math.min(1, ((p.longitude - a.longitude) * dx + (p.latitude - a.latitude) * dy) / (dx * dx + dy * dy)));
    return (p.longitude - a.longitude - t * dx) ** 2 + (p.latitude - a.latitude - t * dy) ** 2;
  };
  let maxD = 0, maxI = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = sqDist(points[i], points[0], points[points.length - 1]);
    if (d > maxD) { maxD = d; maxI = i; }
  }
  if (maxD > tol * tol) {
    const L = simplifyPath(points.slice(0, maxI + 1), tol);
    return [...L.slice(0, -1), ...simplifyPath(points.slice(maxI), tol)];
  }
  return [points[0], points[points.length - 1]];
};

const haversine = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export default function MapScreen() {
  const { mac: macParam } = useLocalSearchParams<{ mac?: string }>();
  const mapRef = useRef<MapView>(null);
  const [region, setRegion] = useState(DEFAULT_REGION);
  const [detections, setDetections] = useState<DetectionRow[]>([]);
  const [recentDevices, setRecentDevices] = useState<{ mac: string; count: number; lastSeen: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [userLoc, setUserLoc] = useState<{ latitude: number; longitude: number } | null>(null);
  const [locGranted, setLocGranted] = useState(false);
  const [activeMac, setActiveMac] = useState(macParam ? String(macParam) : undefined);
  const [vizMode, setVizMode] = useState<VizMode>("path");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [showDist, setShowDist] = useState(false);

  const filtered = useMemo(() => {
    const mins = TIME_FILTERS.find(f => f.key === timeFilter)?.minutes;
    if (!mins) return detections;
    const cutoff = Date.now() - mins * 60000;
    return detections.filter(d => d.detected_at && new Date(d.detected_at).getTime() > cutoff);
  }, [detections, timeFilter]);

  const withCoords = useMemo(() => filtered.filter(d => d.latitude != null && d.longitude != null), [filtered]);
  const sorted = useMemo(() => [...withCoords].sort((a, b) => new Date(a.detected_at!).getTime() - new Date(b.detected_at!).getTime()), [withCoords]);
  const mostRecent = sorted[sorted.length - 1];

  const path = useMemo(() => {
    const coords = sorted.map(d => ({ latitude: d.latitude!, longitude: d.longitude! }));
    return simplifyPath(coords, coords.length > 100 ? 0.0001 : 0.00005);
  }, [sorted]);

  const distSegments = useMemo(() => {
    if (!showDist || sorted.length < 2 || !userLoc) return [];
    const dists = sorted.map(d => haversine(d.latitude!, d.longitude!, userLoc.latitude, userLoc.longitude));
    const min = Math.min(...dists), range = Math.max(...dists) - min || 1;
    return sorted.slice(0, -1).map((a, i) => {
      const mid = haversine((a.latitude! + sorted[i + 1].latitude!) / 2, (a.longitude! + sorted[i + 1].longitude!) / 2, userLoc.latitude, userLoc.longitude);
      const n = (mid - min) / range;
      const [r, g] = n < 0.5 ? [Math.round(510 * n), 255] : [255, Math.round(255 * (1 - (n - 0.5) * 2))];
      return { coords: [{ latitude: a.latitude!, longitude: a.longitude! }, { latitude: sorted[i + 1].latitude!, longitude: sorted[i + 1].longitude! }], color: `rgb(${r},${g},50)` };
    });
  }, [showDist, sorted, userLoc]);

  const requestLoc = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status === "granted") {
      setLocGranted(true);
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setUserLoc({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
      if (!activeMac) setRegion({ latitude: loc.coords.latitude, longitude: loc.coords.longitude, latitudeDelta: 0.02, longitudeDelta: 0.02 });
    }
  };

  const loadDevices = async () => {
    const data = await getDetections({ limit: 500 });
    const map = new Map<string, { count: number; lastSeen: string }>();
    data.forEach(d => {
      if (!d.detected_at) return;
      const e = map.get(d.mac_address);
      const t = new Date(d.detected_at).getTime();
      map.set(d.mac_address, { count: (e?.count ?? 0) + 1, lastSeen: !e || t > new Date(e.lastSeen).getTime() ? d.detected_at : e.lastSeen });
    });
    setRecentDevices([...map.entries()].map(([mac, v]) => ({ mac, ...v })).sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()).slice(0, 10));
  };

  const loadDetections = async (mac?: string) => {
    if (!mac) return setDetections([]);
    if (!refreshing) setLoading(true);
    const data = await getDetections({ limit: 500 });
    const f = data.filter(d => d.mac_address === mac);
    const wc = f.filter(d => d.latitude != null && d.longitude != null);
    if (wc.length) {
      const lats = wc.map(d => d.latitude!), lngs = wc.map(d => d.longitude!);
      setRegion({ latitude: (Math.min(...lats) + Math.max(...lats)) / 2, longitude: (Math.min(...lngs) + Math.max(...lngs)) / 2, latitudeDelta: Math.max(0.005, (Math.max(...lats) - Math.min(...lats)) * 1.5), longitudeDelta: Math.max(0.005, (Math.max(...lngs) - Math.min(...lngs)) * 1.5) });
    }
    setDetections(f);
    setLoading(false);
    setRefreshing(false);
  };

  useEffect(() => { requestLoc(); loadDevices(); if (activeMac) loadDetections(activeMac); }, []);
  useEffect(() => { if (macParam && String(macParam) !== activeMac) { setActiveMac(String(macParam)); loadDetections(String(macParam)); } }, [macParam]);

  const fmtMac = (m: string) => m.length <= 11 ? m : `${m.slice(0, 5)}…${m.slice(-5)}`;
  const fmtAgo = (d: string) => { const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };

  return (
    <SafeAreaView style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.row}>
          <Text style={s.title}>{activeMac ? "Tracking" : "Map"}</Text>
          {activeMac && <Pressable style={s.chip} onPress={() => { setActiveMac(undefined); setDetections([]); userLoc && setRegion({ ...userLoc, latitudeDelta: 0.02, longitudeDelta: 0.02 }); }}><Text style={s.chipTxt}>{fmtMac(activeMac)}</Text><Text style={s.chipX}>✕</Text></Pressable>}
        </View>
        <View style={s.row}>
          <Pressable style={s.btn} onPress={async () => { if (!locGranted) return requestLoc(); const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }); setUserLoc({ latitude: l.coords.latitude, longitude: l.coords.longitude }); setRegion({ latitude: l.coords.latitude, longitude: l.coords.longitude, latitudeDelta: 0.01, longitudeDelta: 0.01 }); }}><Text>📍</Text></Pressable>
          <Pressable style={[s.btn, refreshing && { opacity: 0.5 }]} disabled={refreshing} onPress={() => { setRefreshing(true); activeMac ? loadDetections(activeMac) : (loadDevices(), setRefreshing(false)); }}><Text>{refreshing ? "⏳" : "↻"}</Text></Pressable>
        </View>
      </View>

      {/* Controls */}
      {activeMac && (
        <View style={s.ctrl}>
          <View style={s.row}>{[{ k: "path", l: "Path", i: "〰️" }, { k: "bubbles", l: "Bubbles", i: "◯" }].map(m => <Pressable key={m.k} style={[s.modeBtn, vizMode === m.k && s.modeBtnOn]} onPress={() => setVizMode(m.k as VizMode)}><Text>{m.i}</Text><Text style={[s.modeLbl, vizMode === m.k && s.modeLblOn]}>{m.l}</Text></Pressable>)}</View>
          <View style={s.row}>
            {TIME_FILTERS.map(f => <Pressable key={f.key} style={[s.timeBtn, timeFilter === f.key && s.timeBtnOn]} onPress={() => setTimeFilter(f.key)}><Text style={[s.timeTxt, timeFilter === f.key && s.timeTxtOn]}>{f.label}</Text></Pressable>)}
            {vizMode === "path" && <Pressable style={[s.distBtn, showDist && s.distBtnOn]} onPress={() => setShowDist(!showDist)}><Text>🎨</Text></Pressable>}
          </View>
          <View style={s.rowBtw}><Text style={s.stat}>{withCoords.length} pts{timeFilter !== "all" && ` (${timeFilter})`}</Text>{vizMode === "path" && <Text style={s.stat}>Path: {path.length} segs</Text>}</View>
        </View>
      )}

      {/* Map */}
      <View style={s.mapWrap}>
        <MapView ref={mapRef} style={s.map} provider={PROVIDER_GOOGLE} region={region} onRegionChangeComplete={setRegion} customMapStyle={darkStyle} showsUserLocation={locGranted} showsMyLocationButton={false}>
          {activeMac && vizMode === "path" && !showDist && path.length >= 2 && <Polyline coordinates={path} strokeColor="#23b8f0" strokeWidth={3} />}
          {activeMac && vizMode === "path" && showDist && distSegments.map((seg, i) => <Polyline key={i} coordinates={seg.coords} strokeColor={seg.color} strokeWidth={4} />)}
          {activeMac && vizMode === "path" && path.length >= 2 && <>
            <Marker coordinate={path[0]} anchor={{ x: 0.5, y: 0.5 }}><View style={s.startMk}><Text style={s.mkTxt}>S</Text></View></Marker>
            <Marker coordinate={path[path.length - 1]} anchor={{ x: 0.5, y: 0.5 }}><View style={s.endMk}><View style={s.endMkIn} /></View></Marker>
          </>}
          {activeMac && vizMode === "bubbles" && withCoords.slice(0, 50).map((d, i) => <Circle key={i} center={{ latitude: d.latitude!, longitude: d.longitude! }} radius={Math.max(20, (d.estimated_distance ?? 30) * 2)} strokeColor={d === mostRecent ? "#00ffaa" : "rgba(35,184,240,0.6)"} strokeWidth={d === mostRecent ? 3 : 1} fillColor={d === mostRecent ? "rgba(0,255,170,0.25)" : "rgba(35,184,240,0.1)"} />)}
        </MapView>
        {loading && <View style={s.overlay}><ActivityIndicator size="large" color="#23b8f0" /></View>}
        {!activeMac && (
          <View style={s.overlay}>
            <View style={s.picker}>
              <Text style={s.pickTitle}>Select a Device</Text>
              <Text style={s.pickSub}>Choose from recent detections</Text>
              {recentDevices.length ? <ScrollView style={{ maxHeight: 280 }}>{recentDevices.map(d => <Pressable key={d.mac} style={s.devItem} onPress={() => { setActiveMac(d.mac); loadDetections(d.mac); }}><View><Text style={s.devMac}>{d.mac}</Text><Text style={s.devMeta}>{d.count} · {fmtAgo(d.lastSeen)}</Text></View><Text style={{ color: "#23b8f0" }}>→</Text></Pressable>)}</ScrollView> : <Text style={s.pickSub}>No recent devices</Text>}
              <Pressable style={s.goBtn} onPress={() => router.push("/(tabs)/detections")}><Text style={s.goTxt}>Browse All</Text></Pressable>
            </View>
          </View>
        )}
      </View>

      {/* Legend */}
      {activeMac && vizMode === "path" && showDist && (userLoc ? (
        <View style={s.legend}><Text style={s.legLbl}>Distance from You</Text><View style={s.legGrad}><View style={[s.legStop, { backgroundColor: "#00ff50" }]} /><View style={[s.legStop, { backgroundColor: "#ffaa00" }]} /><View style={[s.legStop, { backgroundColor: "#ff3232" }]} /></View><View style={s.rowBtw}><Text style={s.legTxt}>Closest</Text><Text style={s.legTxt}>Farthest</Text></View></View>
      ) : <View style={s.legend}><Text style={s.legLbl}>📍 Enable location for distance colors</Text></View>)}
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0a1018" },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 12, borderBottomWidth: 1, borderBottomColor: "rgba(35,184,240,0.1)" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowBtw: { flexDirection: "row", justifyContent: "space-between" },
  title: { color: "#e6edf5", fontSize: 20, fontWeight: "700" },
  chip: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(35,184,240,0.15)", paddingHorizontal: 10, paddingVertical: 5, borderRadius: 14, gap: 6 },
  chipTxt: { color: "#23b8f0", fontSize: 11, fontWeight: "600", fontFamily: "monospace" },
  chipX: { color: "#ff6b6b", fontSize: 12, fontWeight: "700" },
  btn: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(35,184,240,0.1)", alignItems: "center", justifyContent: "center" },
  ctrl: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  modeBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, paddingVertical: 8, borderRadius: 8, backgroundColor: "rgba(255,255,255,0.05)", borderWidth: 1, borderColor: "rgba(255,255,255,0.08)" },
  modeBtnOn: { backgroundColor: "rgba(35,184,240,0.2)", borderColor: "#23b8f0" },
  modeLbl: { color: "#6b7a8f", fontSize: 11, fontWeight: "600" },
  modeLblOn: { color: "#23b8f0" },
  timeBtn: { flex: 1, paddingVertical: 6, borderRadius: 6, backgroundColor: "rgba(255,255,255,0.03)", alignItems: "center" },
  timeBtnOn: { backgroundColor: "rgba(35,184,240,0.15)" },
  timeTxt: { color: "#5a6577", fontSize: 11, fontWeight: "600" },
  timeTxtOn: { color: "#23b8f0" },
  distBtn: { width: 36, alignItems: "center", justifyContent: "center", borderRadius: 6, backgroundColor: "rgba(255,255,255,0.03)" },
  distBtnOn: { backgroundColor: "rgba(255,200,50,0.2)" },
  stat: { color: "#4a5568", fontSize: 10 },
  mapWrap: { flex: 1, margin: 10, borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: "rgba(35,184,240,0.15)" },
  map: { flex: 1 },
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(10,16,24,0.85)", justifyContent: "center", alignItems: "center", padding: 20 },
  startMk: { width: 24, height: 24, borderRadius: 12, backgroundColor: "#23b8f0", alignItems: "center", justifyContent: "center" },
  mkTxt: { color: "#fff", fontSize: 11, fontWeight: "700" },
  endMk: { width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(0,255,170,0.3)", alignItems: "center", justifyContent: "center" },
  endMkIn: { width: 10, height: 10, borderRadius: 5, backgroundColor: "#00ffaa" },
  picker: { width: "100%", maxWidth: 340, backgroundColor: "#111a24", borderRadius: 16, padding: 20, borderWidth: 1, borderColor: "rgba(35,184,240,0.2)" },
  pickTitle: { color: "#e6edf5", fontSize: 18, fontWeight: "700", marginBottom: 4 },
  pickSub: { color: "#5a6577", fontSize: 12, marginBottom: 16 },
  devItem: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 12, marginBottom: 8, backgroundColor: "rgba(35,184,240,0.08)", borderRadius: 10, borderWidth: 1, borderColor: "rgba(35,184,240,0.15)" },
  devMac: { color: "#e6edf5", fontSize: 13, fontWeight: "600", fontFamily: "monospace" },
  devMeta: { color: "#5a6577", fontSize: 10, marginTop: 2 },
  goBtn: { marginTop: 16, paddingVertical: 12, backgroundColor: "#23b8f0", borderRadius: 10, alignItems: "center" },
  goTxt: { color: "#0a1018", fontSize: 14, fontWeight: "700" },
  legend: { marginHorizontal: 12, marginBottom: 10, padding: 10, borderRadius: 10, backgroundColor: "rgba(17,26,36,0.95)", borderWidth: 1, borderColor: "rgba(35,184,240,0.15)" },
  legLbl: { color: "#8899aa", fontSize: 10, marginBottom: 6, textAlign: "center" },
  legGrad: { flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden" },
  legStop: { flex: 1 },
  legTxt: { color: "#5a6577", fontSize: 9 },
});

const darkStyle = [
  { elementType: "geometry", stylers: [{ color: "#1a2332" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#7a8a9a" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#1a2332" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a3a4a" }] },
  { featureType: "road", elementType: "labels", stylers: [{ visibility: "simplified" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0f1a28" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
];