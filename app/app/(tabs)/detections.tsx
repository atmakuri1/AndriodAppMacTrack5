// app/(tabs)/detections.tsx - With live streaming and search mode control
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Platform,
  TextInput,
  Pressable,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { DetectionRow, getDetections, createDetectionsBatch } from "../../api";
import {
  collectDetectionsFromEsp32,
  collectDetectionsLive,
  stopLiveStream,
  isLiveStreamActive,
  scanForNearbyDevices,
  SimpleBleDevice,
  LiveStreamStatus,
  startSearchMode,
  stopSearchMode,
} from "../../bleClient";
import * as SecureStore from "expo-secure-store";
import { PermissionsAndroid } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const DEV_FAKE_DEVICES = false;

// Reusable Components
const SignalBars = ({ rssi }: { rssi: number | null }) => {
  if (!rssi) return <Text style={s.value}>—</Text>;
  const strength = Math.min(4, Math.max(1, Math.floor((rssi + 100) / 15)));
  
  return (
    <View style={s.signalBars}>
      {[1, 2, 3, 4].map((bar) => (
        <View
          key={bar}
          style={[
            s.bar,
            { height: bar * 4 + 4, backgroundColor: bar <= strength ? "#5cd6ff" : "#2a3b4c" }
          ]}
        />
      ))}
      <Text style={s.signalText}>{rssi} dBm</Text>
    </View>
  );
};

const SkeletonCard = () => (
  <View style={[s.card, s.skeleton]}>
    <View style={[s.skeletonLine, { width: "60%" }]} />
    <View style={[s.skeletonLine, { width: "40%" }]} />
    <View style={[s.skeletonLine, { width: "80%" }]} />
  </View>
);

const IconButton = ({ name, onPress, disabled, color = "#5cd6ff", bg }: any) => (
  <Pressable
    onPress={onPress}
    disabled={disabled}
    style={[s.iconBtn, bg && { backgroundColor: bg }, disabled && s.disabled]}
  >
    <Ionicons name={name} size={16} color={color} />
  </Pressable>
);

// Connection status type
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'collecting' | 'uploading';

export default function DetectionsScreen() {
  const router = useRouter();
  const { event_id: initialEventId, mac: macFromParams } = useLocalSearchParams<{
    event_id?: string;
    mac?: string;
  }>();

  // State
  const [rows, setRows] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [eventInput, setEventInput] = useState(initialEventId ?? "");
  const [activeEventId, setActiveEventId] = useState<string | undefined>(initialEventId as string);
  const [activeMac, setActiveMac] = useState<string | undefined>(macFromParams as string);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<SimpleBleDevice[]>(
    DEV_FAKE_DEVICES ? [{ id: "FAKE-1", name: "BluStick A" }] : []
  );
  const [deviceError, setDeviceError] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState("");
  
  // Connection state for better status display
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [connectedDeviceName, setConnectedDeviceName] = useState<string>("");
  
  // Search mode state
  const [searchModeActive, setSearchModeActive] = useState(false);
  const [searchingDevice, setSearchingDevice] = useState<SimpleBleDevice | null>(null);
  const [searchTargetMac, setSearchTargetMac] = useState("");

  // Live streaming state
  const [liveStreamActive, setLiveStreamActive] = useState(false);
  const [liveStreamDevice, setLiveStreamDevice] = useState<SimpleBleDevice | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStreamStatus>({
    isStreaming: false,
    detectionCount: 0,
    uploadedCount: 0,
    errorCount: 0,
    pendingCount: 0,
    lastDetection: null,
  });
  const liveStreamRef = useRef<boolean>(false);

  // Load detections
  const loadDetections = async (eventId?: string, mac?: string) => {
    try {
      setErr("");
      if (!refreshing) setLoading(true);

      const data = await getDetections({
        event_id: eventId,
        mac_address: mac,
        limit: 200,
      });

      setRows(data);
    } catch (e: any) {
      setErr(e?.message || "Failed to load");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Effects
  useEffect(() => {
    loadDetections(activeEventId, activeMac);
  }, []);

  useEffect(() => {
    if (macFromParams && macFromParams !== activeMac) {
      setActiveMac(macFromParams as string);
      loadDetections(activeEventId, macFromParams as string);
    }
  }, [macFromParams]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (liveStreamRef.current) {
        stopLiveStream();
      }
    };
  }, []);

  // Actions
  const applyFilter = () => {
    const trimmed = eventInput.trim();
    const next = trimmed || undefined;
    setActiveEventId(next);
    loadDetections(next, activeMac);
  };

  const clearFilter = () => {
    setEventInput("");
    setActiveEventId(undefined);
    setActiveMac(undefined);
    loadDetections();
  };

  const viewOnMap = () => {
    if (!activeMac) {
      Alert.alert("No Device", "Select a MAC address first");
      return;
    }
    router.push({ pathname: "/(tabs)/map" as any, params: { mac: activeMac } });
  };

  const startScan = async () => {
    try {
      setDeviceError("");
      setScanning(true);

      if (Platform.OS === "android" && Platform.Version >= 31) {
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);

        if (!Object.values(granted).every((v) => v === "granted")) {
          setDeviceError("Permissions denied");
          return;
        }
      }

      if (DEV_FAKE_DEVICES) {
        await new Promise((r) => setTimeout(r, 800));
        return;
      }

      const list = await scanForNearbyDevices(8000);
      setDevices(list);
      if (!list.length) setDeviceError("No devices found");
    } catch (e: any) {
      setDeviceError(e?.message || "Scan failed");
    } finally {
      setScanning(false);
    }
  };

  // Activate search mode on a device
  const activateSearchMode = async (device: SimpleBleDevice) => {
    if (!searchTargetMac.trim()) {
      Alert.alert("Missing MAC", "Enter a target MAC address to search for");
      return;
    }

    try {
      setSyncing(true);
      setConnectionState('connecting');
      setConnectedDeviceName(device.name ?? device.id);

      await startSearchMode(device.id, searchTargetMac);
      
      setSearchModeActive(true);
      setSearchingDevice(device);
      setConnectionState('idle');
      
      Alert.alert(
        "Search Mode Active",
        `${device.name ?? device.id} is now searching for:\n${searchTargetMac.toUpperCase()}`
      );
    } catch (e: any) {
      Alert.alert("Failed", e?.message || "Could not activate search mode");
      setConnectionState('idle');
    } finally {
      setSyncing(false);
    }
  };

  // Deactivate search mode
  const deactivateSearchMode = async () => {
    if (!searchingDevice) return;

    try {
      setSyncing(true);
      setConnectionState('connecting');

      await stopSearchMode(searchingDevice.id);
      
      setSearchModeActive(false);
      setSearchingDevice(null);
      setConnectionState('idle');
      
      Alert.alert("Search Stopped", "Device returned to passive mode");
    } catch (e: any) {
      Alert.alert("Failed", e?.message || "Could not stop search mode");
      setConnectionState('idle');
    } finally {
      setSyncing(false);
    }
  };

  // Start live streaming
  const startLiveSync = async (device: SimpleBleDevice) => {
    try {
      const token = await SecureStore.getItemAsync("token");
      if (!token) {
        Alert.alert("Error", "Not authenticated");
        return;
      }

      setSyncing(true);
      setConnectionState('connecting');
      setConnectedDeviceName(device.name ?? device.id);
      setLiveStreamActive(true);
      setLiveStreamDevice(device);
      liveStreamRef.current = true;

      // Reset live status
      setLiveStatus({
        isStreaming: true,
        detectionCount: 0,
        uploadedCount: 0,
        errorCount: 0,
        pendingCount: 0,
        lastDetection: null,
      });

      // Start live collection with batched real-time upload
      const finalStatus = await collectDetectionsLive(
        activeEventId ?? null,
        async (detections) => {
          // Upload batch of detections
          await createDetectionsBatch(detections);
        },
        (status) => {
          // Update UI with live status
          setLiveStatus(status);
          if (status.isStreaming && connectionState !== 'connected') {
            setConnectionState('connected');
          }
        },
        { deviceId: device.id, timeoutMs: 0 } // 0 = no timeout, manual stop
      );

      Alert.alert(
        "Live Stream Ended",
        `Detected: ${finalStatus.detectionCount}\nUploaded: ${finalStatus.uploadedCount}\nErrors: ${finalStatus.errorCount}`
      );

      await loadDetections(activeEventId, activeMac);
      setDevices([]);
    } catch (e: any) {
      const msg = e?.message?.includes("401") ? "Auth error" :
                  e?.message?.includes("Network") ? "Network error" :
                  e?.message || "Live sync failed";
      Alert.alert("Live Sync Failed", msg);
      setErr(msg);
    } finally {
      setSyncing(false);
      setConnectionState('idle');
      setConnectedDeviceName("");
      setLiveStreamActive(false);
      setLiveStreamDevice(null);
      liveStreamRef.current = false;
      setLiveStatus({
        isStreaming: false,
        detectionCount: 0,
        uploadedCount: 0,
        errorCount: 0,
        pendingCount: 0,
        lastDetection: null,
      });
    }
  };

  // Stop live streaming
  const handleStopLiveStream = () => {
    Alert.alert(
      "Stop Live Stream",
      "Are you sure you want to stop the live stream?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Stop", 
          style: "destructive",
          onPress: () => {
            stopLiveStream();
            liveStreamRef.current = false;
          }
        }
      ]
    );
  };

  // Batch sync (original functionality, kept for comparison/fallback)
  const syncDeviceBatch = async (deviceId: string, deviceName: string) => {
    try {
      if (DEV_FAKE_DEVICES) {
        Alert.alert("Success", "Dev mode sync");
        return;
      }

      setSyncing(true);
      setConnectionState('connecting');
      setConnectedDeviceName(deviceName);

      const token = await SecureStore.getItemAsync("token");
      if (!token) {
        Alert.alert("Error", "Not authenticated");
        return;
      }

      // Small delay to show connecting state
      await new Promise(r => setTimeout(r, 500));
      setConnectionState('connected');
      setSyncStatus("Reading data...");

      // Another small delay then show collecting
      await new Promise(r => setTimeout(r, 1000));
      setConnectionState('collecting');

      const batch = await collectDetectionsFromEsp32(activeEventId ?? null, 30000, { deviceId });

      if (!batch.length) {
        Alert.alert("Info", "No detections collected");
        setDevices([]);
        return;
      }

      setConnectionState('uploading');
      setSyncStatus(`Uploading ${batch.length}...`);
      await createDetectionsBatch(batch);
      
      Alert.alert("Success", `${batch.length} detections uploaded!`);
      await loadDetections(activeEventId, activeMac);
      setDevices([]);
    } catch (e: any) {
      const msg = e?.message?.includes("401") ? "Auth error" :
                  e?.message?.includes("Network") ? "Network error" :
                  e?.message || "Sync failed";
      Alert.alert("Sync Failed", msg);
      setErr(msg);
    } finally {
      setSyncing(false);
      setConnectionState('idle');
      setConnectedDeviceName("");
      setSyncStatus("");
    }
  };

  // Get status display based on connection state
  const getConnectionStatusDisplay = () => {
    switch (connectionState) {
      case 'connecting':
        return { icon: "bluetooth", text: `Connecting to ${connectedDeviceName}...`, color: "#ffa500" };
      case 'connected':
        return { icon: "checkmark-circle", text: `Connected to ${connectedDeviceName}`, color: "#4cd964" };
      case 'collecting':
        return { icon: "radio", text: `Reading data from ${connectedDeviceName}...`, color: "#5cd6ff" };
      case 'uploading':
        return { icon: "cloud-upload", text: `Uploading...`, color: "#5cd6ff" };
      default:
        return null;
    }
  };

  // Render helpers
  const renderDetection = useCallback(({ item }: { item: DetectionRow }) => (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={[s.mac, { fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) }]}>
          {item.mac_address ?? "unknown"}
        </Text>
        {item.signal_type && (
          <View style={s.badge}>
            <Text style={s.badgeText}>{item.signal_type}</Text>
          </View>
        )}
      </View>

      <View style={s.grid}>
        <View style={s.gridItem}>
          <Text style={s.label}>SIGNAL</Text>
          <SignalBars rssi={item.rssi} />
        </View>
        <View style={s.gridItem}>
          <Text style={s.label}>DISTANCE</Text>
          <Text style={s.value}>
            {item.estimated_distance ? `${item.estimated_distance.toFixed(2)} m` : "—"}
          </Text>
        </View>
      </View>

      <View style={s.grid}>
        <View style={s.gridItem}>
          <Text style={s.label}>LAT</Text>
          <Text style={s.value}>{item.latitude?.toFixed(6) ?? "—"}</Text>
        </View>
        <View style={s.gridItem}>
          <Text style={s.label}>LNG</Text>
          <Text style={s.value}>{item.longitude?.toFixed(6) ?? "—"}</Text>
        </View>
      </View>

      <View style={s.timeRow}>
        <Ionicons name="time-outline" size={12} color="#7f8a99" />
        <Text style={s.time}>{new Date(item.detected_at).toLocaleString()}</Text>
      </View>
    </View>
  ), []);

  const keyExtractor = useCallback(
    (item: DetectionRow, idx: number) =>
      `${item.blustick_id}-${item.mac_address}-${item.detected_at}-${idx}`,
    []
  );

  const connectionStatus = getConnectionStatusDisplay();

  return (
    <SafeAreaView style={s.root}>
      <View style={s.divider} />
      
      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderDetection}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={s.content}
        removeClippedSubviews
        maxToRenderPerBatch={10}
        initialNumToRender={10}
        windowSize={10}
        ListHeaderComponent={
          <>
            {/* Filter */}
            <View style={s.section}>
              <Text style={s.sectionLabel}>EVENT FILTER</Text>
              <View style={s.inputRow}>
                <TextInput
                  style={s.input}
                  value={eventInput}
                  onChangeText={setEventInput}
                  placeholder="Event ID (optional)"
                  placeholderTextColor="#9aa4b2"
                />
                <Pressable onPress={applyFilter} style={s.applyBtn}>
                  <Text style={s.applyText}>Apply</Text>
                </Pressable>
              </View>

              {/* Actions */}
              <View style={s.actions}>
                <Pressable
                  onPress={startScan}
                  disabled={scanning || syncing || liveStreamActive}
                  style={[s.syncBtn, (scanning || syncing || liveStreamActive) && s.disabled]}
                >
                  <Ionicons name="bluetooth" size={16} color="#0b1420" />
                  <Text style={s.syncText}>{scanning ? "Scanning" : "Scan"}</Text>
                </Pressable>

                <IconButton name="refresh" onPress={() => { setRefreshing(true); loadDetections(activeEventId, activeMac); }} disabled={refreshing || liveStreamActive} />
                {activeMac && <IconButton name="map" onPress={viewOnMap} />}
                {(activeEventId || activeMac) && <IconButton name="close" onPress={clearFilter} color="#ff6b6b" />}
              </View>
            </View>

            {/* Connection Status Bar (for batch sync) */}
            {connectionStatus && !liveStreamActive && (
              <View style={[s.connectionBar, { borderColor: connectionStatus.color }]}>
                <View style={[s.connectionDot, { backgroundColor: connectionStatus.color }]} />
                <Ionicons name={connectionStatus.icon as any} size={18} color={connectionStatus.color} />
                <Text style={[s.connectionText, { color: connectionStatus.color }]}>
                  {connectionStatus.text}
                </Text>
                {connectionState === 'collecting' && (
                  <ActivityIndicator size="small" color={connectionStatus.color} style={{ marginLeft: 'auto' }} />
                )}
              </View>
            )}

            {/* Live Stream Status Bar */}
            {liveStreamActive && liveStreamDevice && (
              <View style={s.liveStreamBar}>
                <View style={s.liveStreamContent}>
                  <View style={s.liveIndicator}>
                    <View style={s.liveDot} />
                    <Text style={s.liveText}>LIVE</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={s.liveConnectedRow}>
                      <Ionicons name="checkmark-circle" size={14} color="#4cd964" />
                      <Text style={s.liveDeviceName}>{liveStreamDevice.name ?? liveStreamDevice.id}</Text>
                    </View>
                    <View style={s.liveStats}>
                      <Text style={s.liveStat}>
                        <Text style={s.liveStatValue}>{liveStatus.detectionCount}</Text> detected
                      </Text>
                      <Text style={s.liveStat}>
                        <Text style={s.liveStatValue}>{liveStatus.uploadedCount}</Text> uploaded
                      </Text>
                      {liveStatus.pendingCount > 0 && (
                        <Text style={[s.liveStat, { color: "#ffa500" }]}>
                          <Text style={s.liveStatValue}>{liveStatus.pendingCount}</Text> pending
                        </Text>
                      )}
                      {liveStatus.errorCount > 0 && (
                        <Text style={[s.liveStat, { color: "#ff6b6b" }]}>
                          <Text style={s.liveStatValue}>{liveStatus.errorCount}</Text> errors
                        </Text>
                      )}
                    </View>
                    {liveStatus.lastDetection && (
                      <Text style={s.lastDetection}>
                        Last: {liveStatus.lastDetection.mac_address}
                      </Text>
                    )}
                  </View>
                  <Pressable
                    onPress={handleStopLiveStream}
                    style={s.stopLiveBtn}
                  >
                    <Ionicons name="stop-circle" size={24} color="#ff6b6b" />
                    <Text style={s.stopLiveText}>Stop</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Search Mode Status */}
            {searchModeActive && searchingDevice && !liveStreamActive && (
              <View style={s.searchModeBar}>
                <View style={s.searchModeContent}>
                  <View style={s.searchModeIcon}>
                    <Ionicons name="search" size={16} color="#5cd6ff" />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={s.searchModeTitle}>🔍 Active Search Mode</Text>
                    <Text style={s.searchModeDevice}>{searchingDevice.name ?? searchingDevice.id}</Text>
                    <Text style={s.searchModeTarget}>Target: {searchTargetMac.toUpperCase()}</Text>
                  </View>
                  <Pressable
                    onPress={deactivateSearchMode}
                    disabled={syncing}
                    style={[s.stopSearchBtn, syncing && s.disabled]}
                  >
                    <Ionicons name="stop-circle" size={20} color="#ff6b6b" />
                    <Text style={s.stopSearchText}>Stop</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Devices - Compact version */}
            <View style={s.devicesSection}>
              <View style={s.deviceHeader}>
                <Ionicons name="hardware-chip-outline" size={16} color="#5cd6ff" />
                <Text style={s.deviceHeaderTitle}>Nearby Devices</Text>
                {devices.length > 0 && (
                  <View style={s.deviceCount}>
                    <Text style={s.deviceCountText}>{devices.length}</Text>
                  </View>
                )}
              </View>

              {/* Target MAC Input (for search mode) - inline */}
              {devices.length > 0 && !searchModeActive && !liveStreamActive && (
                <View style={s.targetMacRow}>
                  <Text style={s.targetMacLabel}>Search target:</Text>
                  <TextInput
                    style={s.targetMacInputCompact}
                    value={searchTargetMac}
                    onChangeText={setSearchTargetMac}
                    placeholder="AA:BB:CC:DD:EE:FF"
                    placeholderTextColor="#7f8a99"
                    autoCapitalize="characters"
                  />
                </View>
              )}

              {scanning ? (
                <View style={s.deviceLoading}>
                  <ActivityIndicator size="small" color="#5cd6ff" />
                  <Text style={s.deviceLoadingText}>Scanning...</Text>
                </View>
              ) : deviceError ? (
                <View style={s.deviceErrorRow}>
                  <Ionicons name="alert-circle-outline" size={16} color="#ff6b6b" />
                  <Text style={s.deviceErrorText}>{deviceError}</Text>
                </View>
              ) : !devices.length ? (
                <Text style={s.noDevicesText}>Tap "Scan" to find devices</Text>
              ) : (
                devices.map((d) => (
                  <View key={d.id} style={s.deviceRow}>
                    <Ionicons name="hardware-chip" size={20} color="#5cd6ff" />
                    <View style={s.deviceInfo}>
                      <Text style={s.deviceName}>{d.name ?? "unnamed"}</Text>
                      <Text style={s.deviceId}>{d.id}</Text>
                    </View>
                    {!searchModeActive && !liveStreamActive && (
                      <View style={s.deviceBtns}>
                        <Pressable
                          style={s.btnSearch}
                          onPress={() => activateSearchMode(d)}
                          disabled={syncing}
                        >
                          <Ionicons name="search" size={12} color="#0b1420" />
                        </Pressable>
                        <Pressable
                          style={s.btnLive}
                          onPress={() => startLiveSync(d)}
                          disabled={syncing}
                        >
                          <Ionicons name="radio" size={12} color="#fff" />
                        </Pressable>
                        <Pressable
                          style={s.btnBatch}
                          onPress={() => syncDeviceBatch(d.id, d.name ?? d.id)}
                          disabled={syncing}
                        >
                          <Ionicons name="cloud-upload-outline" size={12} color="#0b1420" />
                        </Pressable>
                      </View>
                    )}
                  </View>
                ))
              )}
            </View>

            {/* Status */}
            <View style={s.status}>
              <View style={s.statusRow}>
                <Ionicons name={activeMac ? "filter" : "list"} size={14} color="#9aa4b2" />
                <Text style={s.statusLabel}>
                  {activeMac ? (
                    <Text style={s.highlight}>{activeMac}</Text>
                  ) : activeEventId ? (
                    <Text style={s.highlight}>{activeEventId}</Text>
                  ) : (
                    "All detections"
                  )}
                </Text>
              </View>
              <View style={s.count}>
                <Text style={s.countText}>{rows.length}</Text>
              </View>
            </View>
          </>
        }
        ListEmptyComponent={
          loading ? (
            <>
              <SkeletonCard />
              <SkeletonCard />
              <SkeletonCard />
            </>
          ) : err ? (
            <View style={s.center}>
              <Ionicons name="alert-circle-outline" size={48} color="#ff6b6b" />
              <Text style={s.errorText}>{err}</Text>
              <Pressable onPress={() => loadDetections(activeEventId, activeMac)} style={s.retryBtn}>
                <Text style={s.retryText}>Try Again</Text>
              </Pressable>
            </View>
          ) : (
            <View style={s.center}>
              <Ionicons name="radio-outline" size={64} color="#3a4b5c" />
              <Text style={s.emptyTitle}>No Detections</Text>
              <Text style={s.info}>Sync your device to start</Text>
              <Pressable onPress={startScan} style={s.syncBtn}>
                <Text style={s.syncText}>Scan Devices</Text>
              </Pressable>
            </View>
          )
        }
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  divider: { height: 1, backgroundColor: "rgba(92,214,255,0.12)" },
  content: { padding: 16 },
  
  section: { marginBottom: 10, padding: 12, borderRadius: 10, backgroundColor: "rgba(10,18,32,0.9)", borderWidth: 1, borderColor: "rgba(92,214,255,0.18)" },
  sectionLabel: { color: "#9aa4b2", fontSize: 11, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 },
  
  inputRow: { flexDirection: "row", backgroundColor: "#0f1a2a", borderWidth: 1, borderColor: "rgba(92,214,255,0.25)", borderRadius: 10, height: 44, marginBottom: 8 },
  input: { flex: 1, color: "#e6edf5", fontSize: 14, paddingLeft: 12 },
  applyBtn: { paddingHorizontal: 16, backgroundColor: "#23b8f0", borderTopRightRadius: 9, borderBottomRightRadius: 9, justifyContent: "center" },
  applyText: { color: "#0b1420", fontWeight: "700", fontSize: 13 },
  
  actions: { flexDirection: "row", gap: 8, justifyContent: "flex-end" },
  syncBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: "#23b8f0" },
  syncText: { color: "#0b1420", fontSize: 13, fontWeight: "700" },
  iconBtn: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: "rgba(92,214,255,0.4)", backgroundColor: "rgba(35,184,240,0.08)" },
  disabled: { opacity: 0.5 },
  
  // Connection status bar
  connectionBar: { 
    flexDirection: "row", 
    alignItems: "center", 
    gap: 10, 
    backgroundColor: "rgba(18,28,44,0.9)", 
    paddingHorizontal: 12, 
    paddingVertical: 10, 
    borderRadius: 8, 
    marginBottom: 10, 
    borderWidth: 1 
  },
  connectionDot: { width: 8, height: 8, borderRadius: 4 },
  connectionText: { fontSize: 13, fontWeight: "600", flex: 1 },
  
  // Live stream bar
  liveStreamBar: { 
    marginBottom: 10, 
    padding: 10, 
    borderRadius: 10, 
    backgroundColor: "rgba(255,59,48,0.08)", 
    borderWidth: 2, 
    borderColor: "#ff3b30" 
  },
  liveStreamContent: { flexDirection: "row", alignItems: "center", gap: 10 },
  liveIndicator: { 
    flexDirection: "row", 
    alignItems: "center", 
    gap: 5, 
    backgroundColor: "#ff3b30", 
    paddingHorizontal: 8, 
    paddingVertical: 5, 
    borderRadius: 5 
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "#fff" },
  liveText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 1 },
  liveConnectedRow: { flexDirection: "row", alignItems: "center", gap: 4, marginBottom: 2 },
  liveDeviceName: { color: "#e6edf5", fontSize: 13, fontWeight: "600" },
  liveStats: { flexDirection: "row", gap: 10 },
  liveStat: { color: "#9aa4b2", fontSize: 10 },
  liveStatValue: { color: "#5cd6ff", fontWeight: "700" },
  lastDetection: { color: "#7f8a99", fontSize: 9, marginTop: 2, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) },
  stopLiveBtn: { alignItems: "center", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "rgba(255,107,107,0.15)", borderWidth: 1, borderColor: "#ff6b6b" },
  stopLiveText: { color: "#ff6b6b", fontSize: 9, fontWeight: "700", marginTop: 1 },
  
  // Search mode bar
  searchModeBar: { marginBottom: 10, padding: 10, borderRadius: 10, backgroundColor: "rgba(92,214,255,0.08)", borderWidth: 1, borderColor: "#5cd6ff" },
  searchModeContent: { flexDirection: "row", alignItems: "center", gap: 10 },
  searchModeIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: "rgba(92,214,255,0.2)", alignItems: "center", justifyContent: "center" },
  searchModeTitle: { color: "#5cd6ff", fontSize: 12, fontWeight: "700" },
  searchModeDevice: { color: "#e6edf5", fontSize: 11 },
  searchModeTarget: { color: "#9aa4b2", fontSize: 10, fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) },
  stopSearchBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "rgba(255,107,107,0.15)", borderWidth: 1, borderColor: "#ff6b6b" },
  stopSearchText: { color: "#ff6b6b", fontSize: 11, fontWeight: "700" },
  
  // Compact devices section
  devicesSection: { 
    marginBottom: 10, 
    padding: 10, 
    borderRadius: 8, 
    backgroundColor: "rgba(10,18,32,0.9)", 
    borderWidth: 1, 
    borderColor: "rgba(92,214,255,0.18)" 
  },
  deviceHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  deviceHeaderTitle: { color: "#c9d5e3", fontSize: 12, fontWeight: "600", flex: 1 },
  deviceCount: { backgroundColor: "rgba(92,214,255,0.2)", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  deviceCountText: { color: "#5cd6ff", fontSize: 11, fontWeight: "700" },
  
  targetMacRow: { flexDirection: "row", alignItems: "center", marginTop: 8, gap: 8 },
  targetMacLabel: { color: "#7f8a99", fontSize: 11 },
  targetMacInputCompact: { 
    flex: 1, 
    backgroundColor: "#0f1a2a", 
    borderWidth: 1, 
    borderColor: "rgba(92,214,255,0.2)", 
    borderRadius: 6, 
    height: 32, 
    paddingHorizontal: 10, 
    color: "#e6edf5", 
    fontSize: 12, 
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }) 
  },
  
  deviceLoading: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, paddingVertical: 8 },
  deviceLoadingText: { color: "#9aa4b2", fontSize: 12 },
  deviceErrorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  deviceErrorText: { color: "#ff6b6b", fontSize: 11 },
  noDevicesText: { color: "#7f8a99", fontSize: 11, marginTop: 6 },
  
  deviceRow: { 
    flexDirection: "row", 
    alignItems: "center", 
    paddingVertical: 8, 
    paddingHorizontal: 8, 
    marginTop: 6, 
    backgroundColor: "rgba(18,28,44,0.6)", 
    borderRadius: 6, 
    gap: 10 
  },
  deviceInfo: { flex: 1 },
  deviceName: { color: "#e6edf5", fontSize: 13, fontWeight: "600" },
  deviceId: { color: "#7f8a99", fontSize: 10 },
  deviceBtns: { flexDirection: "row", gap: 4 },
  btnSearch: { width: 28, height: 28, borderRadius: 6, backgroundColor: "#5cd6ff", alignItems: "center", justifyContent: "center" },
  btnLive: { width: 28, height: 28, borderRadius: 6, backgroundColor: "#ff3b30", alignItems: "center", justifyContent: "center" },
  btnBatch: { width: 28, height: 28, borderRadius: 6, backgroundColor: "#23b8f0", alignItems: "center", justifyContent: "center" },
  
  // Status bar
  status: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "rgba(18,28,44,0.6)", borderRadius: 6, marginBottom: 10 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, flex: 1 },
  statusLabel: { color: "#9aa4b2", fontSize: 11 },
  highlight: { color: "#5cd6ff", fontWeight: "600" },
  count: { backgroundColor: "rgba(92,214,255,0.15)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)" },
  countText: { color: "#5cd6ff", fontSize: 11, fontWeight: "700" },
  
  // Detection cards
  card: { backgroundColor: "rgba(18,28,44,0.9)", borderWidth: 1, borderColor: "rgba(92,214,255,0.18)", borderRadius: 10, padding: 12 },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  mac: { color: "#e6edf5", fontWeight: "700", fontSize: 14 },
  badge: { backgroundColor: "rgba(35,184,240,0.15)", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)" },
  badgeText: { color: "#5cd6ff", fontSize: 11, fontWeight: "700" },
  
  grid: { flexDirection: "row", marginBottom: 10, gap: 12 },
  gridItem: { flex: 1 },
  label: { color: "#7f8a99", fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  value: { color: "#c9d5e3", fontSize: 14, fontWeight: "600" },
  
  signalBars: { flexDirection: "row", alignItems: "center", gap: 8 },
  bar: { width: 3, borderRadius: 1.5 },
  signalText: { color: "#c9d5e3", fontSize: 12, fontWeight: "600" },
  
  timeRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  time: { color: "#7f8a99", fontSize: 11, fontStyle: "italic" },
  
  skeleton: { opacity: 0.5 },
  skeletonLine: { height: 12, backgroundColor: "rgba(92,214,255,0.1)", borderRadius: 4, marginBottom: 8 },
  
  center: { alignItems: "center", paddingVertical: 40, gap: 12 },
  info: { color: "#9aa4b2", fontSize: 12 },
  errorText: { color: "#ff6b6b", fontSize: 12 },
  retryBtn: { marginTop: 8, paddingHorizontal: 20, paddingVertical: 10, backgroundColor: "rgba(92,214,255,0.1)", borderRadius: 8, borderWidth: 1, borderColor: "rgba(92,214,255,0.3)" },
  retryText: { color: "#5cd6ff", fontWeight: "600", fontSize: 14 },
  emptyTitle: { color: "#e6edf5", fontSize: 18, fontWeight: "700", marginTop: 8 },
});