// app/(tabs)/detections.tsx - With live streaming and search mode during live
import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  ActivityIndicator,
  Platform,
  Pressable,
  Alert,
  ScrollView,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { DetectionRow, getDetections, createDetectionsBatch } from "../../api";
import {
  collectDetectionsFromEsp32,
  collectDetectionsLive,
  stopLiveStream,
  scanForNearbyDevices,
  SimpleBleDevice,
  LiveStreamStatus,
  activateSearchModeLive,
  deactivateSearchModeLive,
} from "../../bleClient";
import * as SecureStore from "expo-secure-store";
import { PermissionsAndroid } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const DEV_FAKE_DEVICES = false;

// Type for tracking unique MACs during live session
type RecentMac = {
  mac: string;
  count: number;
  lastRssi: number | null;
  lastDistance: number | null;
  firstSeen: Date;
  lastSeen: Date;
};

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
  const { mac: macFromParams } = useLocalSearchParams<{
    mac?: string;
  }>();

  // State
  const [rows, setRows] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
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
  const [searchTargetMac, setSearchTargetMac] = useState<string | null>(null);
  const [recentMacs, setRecentMacs] = useState<Map<string, RecentMac>>(new Map());
  const recentMacsRef = useRef<Map<string, RecentMac>>(new Map());

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
  const loadDetections = async (mac?: string) => {
    try {
      setErr("");
      if (!refreshing) setLoading(true);

      const data = await getDetections({
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
    loadDetections(activeMac);
  }, []);

  useEffect(() => {
    if (macFromParams && macFromParams !== activeMac) {
      setActiveMac(macFromParams as string);
      loadDetections(macFromParams as string);
    }
  }, [macFromParams]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (liveStreamRef.current) {
        try {
          stopLiveStream();
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    };
  }, []);

  // Actions
  const clearFilter = () => {
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

  // Activate search mode during live streaming
  const handleActivateSearchMode = async (mac: string) => {
    try {
      console.log('[UI] Activating search mode for:', mac);
      await activateSearchModeLive(mac);
      setSearchModeActive(true);
      setSearchTargetMac(mac);
      Alert.alert("Search Mode Active", `Now tracking only:\n${mac}`);
    } catch (e: any) {
      console.error('[UI] Failed to activate search mode:', e);
      Alert.alert("Error", e?.message || "Failed to activate search mode");
    }
  };

  // Deactivate search mode during live streaming
  const handleDeactivateSearchMode = async () => {
    try {
      console.log('[UI] Deactivating search mode');
      await deactivateSearchModeLive();
      setSearchModeActive(false);
      setSearchTargetMac(null);
      Alert.alert("Search Mode Disabled", "Now tracking all nearby devices");
    } catch (e: any) {
      console.error('[UI] Failed to deactivate search mode:', e);
      Alert.alert("Error", e?.message || "Failed to deactivate search mode");
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

      // Reset recent MACs for this session
      recentMacsRef.current = new Map();
      setRecentMacs(new Map());

      // Reset live status
      setLiveStatus({
        isStreaming: true,
        detectionCount: 0,
        uploadedCount: 0,
        errorCount: 0,
        pendingCount: 0,
        lastDetection: null,
      });

      console.log('[UI] Starting live stream...');

      // Start live collection with batched real-time upload
      const finalStatus = await collectDetectionsLive(
        null, // No event ID
        async (detections) => {
          // Upload batch of detections
          console.log(`[UI] Uploading batch of ${detections.length} detections...`);
          try {
            await createDetectionsBatch(detections);
            console.log(`[UI] ✅ Batch upload complete`);
          } catch (uploadErr: any) {
            console.error(`[UI] ❌ Batch upload failed:`, uploadErr?.message);
            throw uploadErr;
          }
        },
        (status) => {
          // Update UI with live status
          setLiveStatus(status);
          if (status.isStreaming) {
            setConnectionState('connected');
          }
          
          // Track unique MACs from detections
          if (status.lastDetection) {
            const mac = status.lastDetection.mac_address;
            const now = new Date();
            
            const existing = recentMacsRef.current.get(mac);
            if (existing) {
              existing.count++;
              existing.lastRssi = status.lastDetection.rssi;
              existing.lastDistance = status.lastDetection.estimated_distance;
              existing.lastSeen = now;
            } else {
              recentMacsRef.current.set(mac, {
                mac,
                count: 1,
                lastRssi: status.lastDetection.rssi,
                lastDistance: status.lastDetection.estimated_distance,
                firstSeen: now,
                lastSeen: now,
              });
            }
            
            // Update state periodically (every 10 detections to avoid too many re-renders)
            if (status.detectionCount % 10 === 0) {
              setRecentMacs(new Map(recentMacsRef.current));
            }
          }
        },
        { deviceId: device.id, timeoutMs: 0 } // 0 = no timeout, manual stop
      );

      console.log('[UI] ====== LIVE STREAM ENDED ======');
      console.log('[UI] Final status:', JSON.stringify(finalStatus));

      Alert.alert(
        "Live Stream Ended",
        `Detected: ${finalStatus.detectionCount}\nUploaded: ${finalStatus.uploadedCount}\nErrors: ${finalStatus.errorCount}\nUnique MACs: ${recentMacsRef.current.size}`
      );

      await loadDetections(activeMac);
      setDevices([]);
    } catch (e: any) {
      console.error('[UI] ====== LIVE SYNC ERROR ======');
      console.error('[UI] Error:', e);
      const msg = e?.message?.includes("401") ? "Auth error" :
                  e?.message?.includes("Network") ? "Network error" :
                  e?.message || "Live sync failed";
      Alert.alert("Live Sync Failed", msg);
      setErr(msg);
    } finally {
      console.log('[UI] Cleaning up live stream state');
      setSyncing(false);
      setConnectionState('idle');
      setConnectedDeviceName("");
      setLiveStreamActive(false);
      setLiveStreamDevice(null);
      liveStreamRef.current = false;
      setSearchModeActive(false);
      setSearchTargetMac(null);
      setRecentMacs(new Map());
      recentMacsRef.current = new Map();
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

  // Stop live streaming - with crash protection
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
            try {
              stopLiveStream();
              liveStreamRef.current = false;
            } catch (e) {
              console.warn('[UI] Error stopping live stream:', e);
              liveStreamRef.current = false;
            }
          }
        }
      ]
    );
  };

  // Batch sync (one-time collection)
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

      await new Promise(r => setTimeout(r, 500));
      setConnectionState('connected');
      setSyncStatus("Reading data...");

      await new Promise(r => setTimeout(r, 1000));
      setConnectionState('collecting');

      const batch = await collectDetectionsFromEsp32(null, 30000, { deviceId });

      if (!batch.length) {
        Alert.alert("Info", "No detections collected");
        setDevices([]);
        return;
      }

      setConnectionState('uploading');
      setSyncStatus(`Uploading ${batch.length}...`);
      await createDetectionsBatch(batch);
      
      Alert.alert("Success", `${batch.length} detections uploaded!`);
      await loadDetections(activeMac);
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

  // Get sorted recent MACs (by count, descending)
  const getSortedRecentMacs = (): RecentMac[] => {
    return Array.from(recentMacs.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 20); // Show top 20
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
  const sortedRecentMacs = getSortedRecentMacs();

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
            {/* Scan Section - Only show when NOT live streaming */}
            {!liveStreamActive && (
              <View style={s.section}>
                <View style={s.sectionHeader}>
                  <Ionicons name="bluetooth" size={16} color="#5cd6ff" />
                  <Text style={s.sectionLabel}>CONNECT TO BLUSTICK</Text>
                </View>

                <View style={s.actions}>
                  <Pressable
                    onPress={startScan}
                    disabled={scanning || syncing}
                    style={[s.syncBtn, (scanning || syncing) && s.disabled]}
                  >
                    <Ionicons name="bluetooth" size={16} color="#0b1420" />
                    <Text style={s.syncText}>{scanning ? "Scanning..." : "Scan Devices"}</Text>
                  </Pressable>

                  <IconButton 
                    name="refresh" 
                    onPress={() => { setRefreshing(true); loadDetections(activeMac); }} 
                    disabled={refreshing} 
                  />
                  {activeMac && <IconButton name="map" onPress={viewOnMap} />}
                  {activeMac && <IconButton name="close" onPress={clearFilter} color="#ff6b6b" />}
                </View>
              </View>
            )}

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
                    {searchModeActive && searchTargetMac && (
                      <Text style={s.liveSearchTarget}>
                        🎯 Tracking: {searchTargetMac}
                      </Text>
                    )}
                    <View style={s.liveStats}>
                      <Text style={s.liveStat}>
                        <Text style={s.liveStatValue}>{liveStatus.detectionCount}</Text> detected
                      </Text>
                      <Text style={s.liveStat}>
                        <Text style={s.liveStatValue}>{liveStatus.uploadedCount}</Text> uploaded
                      </Text>
                      <Text style={s.liveStat}>
                        <Text style={s.liveStatValue}>{recentMacs.size}</Text> unique
                      </Text>
                      {liveStatus.errorCount > 0 && (
                        <Text style={[s.liveStat, { color: "#ff6b6b" }]}>
                          <Text style={s.liveStatValue}>{liveStatus.errorCount}</Text> errors
                        </Text>
                      )}
                    </View>
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

            {/* Search Mode Section - Only show DURING live streaming */}
            {liveStreamActive && (
              <View style={s.searchSection}>
                <View style={s.sectionHeader}>
                  <Ionicons name="search" size={16} color="#5cd6ff" />
                  <Text style={s.sectionLabel}>SEARCH MODE</Text>
                  {searchModeActive && (
                    <View style={s.activeIndicator}>
                      <Text style={s.activeIndicatorText}>ACTIVE</Text>
                    </View>
                  )}
                </View>
                
                {searchModeActive && searchTargetMac ? (
                  // Show current tracking target with stop button
                  <View style={s.trackingActive}>
                    <View style={s.trackingInfo}>
                      <Ionicons name="locate" size={20} color="#5cd6ff" />
                      <View>
                        <Text style={s.trackingLabel}>Tracking:</Text>
                        <Text style={s.trackingMac}>{searchTargetMac}</Text>
                      </View>
                    </View>
                    <Pressable
                      onPress={handleDeactivateSearchMode}
                      style={s.stopTrackingBtn}
                    >
                      <Ionicons name="close-circle" size={18} color="#ff6b6b" />
                      <Text style={s.stopTrackingText}>Stop Tracking</Text>
                    </Pressable>
                  </View>
                ) : (
                  // Show list of recent MACs to choose from
                  <>
                    <Text style={s.sectionDescription}>
                      Tap a device below to track only that MAC address:
                    </Text>
                    
                    {sortedRecentMacs.length === 0 ? (
                      <View style={s.noMacsContainer}>
                        <Ionicons name="radio-outline" size={32} color="#3a4b5c" />
                        <Text style={s.noMacsText}>Waiting for detections...</Text>
                        <Text style={s.noMacsSubtext}>Devices will appear here as they're detected</Text>
                      </View>
                    ) : (
                      <ScrollView 
                        horizontal 
                        showsHorizontalScrollIndicator={false}
                        style={s.macList}
                        contentContainerStyle={s.macListContent}
                      >
                        {sortedRecentMacs.map((item) => (
                          <Pressable
                            key={item.mac}
                            style={s.macChip}
                            onPress={() => handleActivateSearchMode(item.mac)}
                          >
                            <Text style={s.macChipMac}>{item.mac}</Text>
                            <View style={s.macChipStats}>
                              <Text style={s.macChipCount}>{item.count}x</Text>
                              {item.lastDistance && (
                                <Text style={s.macChipDistance}>
                                  {item.lastDistance.toFixed(1)}m
                                </Text>
                              )}
                            </View>
                          </Pressable>
                        ))}
                      </ScrollView>
                    )}
                  </>
                )}
              </View>
            )}

            {/* Devices Section - Only show when NOT live streaming */}
            {!liveStreamActive && (
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

                {scanning ? (
                  <View style={s.deviceLoading}>
                    <ActivityIndicator size="small" color="#5cd6ff" />
                    <Text style={s.deviceLoadingText}>Scanning for BluStick devices...</Text>
                  </View>
                ) : deviceError ? (
                  <View style={s.deviceErrorRow}>
                    <Ionicons name="alert-circle-outline" size={16} color="#ff6b6b" />
                    <Text style={s.deviceErrorText}>{deviceError}</Text>
                  </View>
                ) : !devices.length ? (
                  <Text style={s.noDevicesText}>Tap "Scan Devices" to find nearby BluStick devices</Text>
                ) : (
                  devices.map((d) => (
                    <View key={d.id} style={s.deviceRow}>
                      <Ionicons name="hardware-chip" size={20} color="#5cd6ff" />
                      <View style={s.deviceInfo}>
                        <Text style={s.deviceName}>{d.name ?? "unnamed"}</Text>
                        <Text style={s.deviceId}>{d.id}</Text>
                      </View>
                      <View style={s.deviceBtns}>
                        <Pressable
                          style={[s.deviceActionBtn, s.btnLive]}
                          onPress={() => startLiveSync(d)}
                          disabled={syncing}
                        >
                          <Ionicons name="radio" size={14} color="#fff" />
                          <Text style={s.deviceActionText}>Live</Text>
                        </Pressable>
                        <Pressable
                          style={[s.deviceActionBtn, s.btnBatch]}
                          onPress={() => syncDeviceBatch(d.id, d.name ?? d.id)}
                          disabled={syncing}
                        >
                          <Ionicons name="cloud-upload-outline" size={14} color="#0b1420" />
                          <Text style={[s.deviceActionText, { color: "#0b1420" }]}>Sync</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))
                )}
                
                {devices.length > 0 && (
                  <View style={s.helpTextContainer}>
                    <Text style={s.helpText}>
                      <Text style={s.helpBold}>Live:</Text> Stream detections in real-time
                    </Text>
                    <Text style={s.helpText}>
                      <Text style={s.helpBold}>Sync:</Text> One-time batch collection (30s)
                    </Text>
                  </View>
                )}
              </View>
            )}

            {/* Status */}
            <View style={s.status}>
              <View style={s.statusRow}>
                <Ionicons name={activeMac ? "filter" : "list"} size={14} color="#9aa4b2" />
                <Text style={s.statusLabel}>
                  {activeMac ? (
                    <>Filtered: <Text style={s.highlight}>{activeMac}</Text></>
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
              <Pressable onPress={() => loadDetections(activeMac)} style={s.retryBtn}>
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
  
  section: { 
    marginBottom: 10, 
    padding: 12, 
    borderRadius: 10, 
    backgroundColor: "rgba(10,18,32,0.9)", 
    borderWidth: 1, 
    borderColor: "rgba(92,214,255,0.18)" 
  },
  sectionHeader: { 
    flexDirection: "row", 
    alignItems: "center", 
    gap: 6, 
    marginBottom: 8 
  },
  sectionLabel: { 
    color: "#9aa4b2", 
    fontSize: 11, 
    textTransform: "uppercase", 
    letterSpacing: 0.5,
    flex: 1,
  },
  sectionDescription: {
    color: "#7f8a99",
    fontSize: 11,
    marginBottom: 10,
    lineHeight: 16,
  },
  activeIndicator: {
    backgroundColor: "#4cd964",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  activeIndicatorText: {
    color: "#0b1420",
    fontSize: 9,
    fontWeight: "800",
  },
  
  // Search section (during live)
  searchSection: {
    marginBottom: 10,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "rgba(92,214,255,0.05)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
  },
  
  // Tracking active state
  trackingActive: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(92,214,255,0.1)",
    padding: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  trackingInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  trackingLabel: {
    color: "#9aa4b2",
    fontSize: 10,
  },
  trackingMac: {
    color: "#5cd6ff",
    fontSize: 14,
    fontWeight: "700",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
  },
  stopTrackingBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: "rgba(255,107,107,0.15)",
    borderWidth: 1,
    borderColor: "rgba(255,107,107,0.3)",
  },
  stopTrackingText: {
    color: "#ff6b6b",
    fontSize: 11,
    fontWeight: "600",
  },
  
  // No MACs state
  noMacsContainer: {
    alignItems: "center",
    paddingVertical: 20,
    gap: 6,
  },
  noMacsText: {
    color: "#9aa4b2",
    fontSize: 13,
  },
  noMacsSubtext: {
    color: "#7f8a99",
    fontSize: 11,
  },
  
  // MAC list (horizontal scroll)
  macList: {
    marginTop: 8,
    marginHorizontal: -12,
  },
  macListContent: {
    paddingHorizontal: 12,
    gap: 8,
  },
  macChip: {
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.3)",
    borderRadius: 8,
    padding: 10,
    minWidth: 140,
  },
  macChipMac: {
    color: "#e6edf5",
    fontSize: 11,
    fontWeight: "600",
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace" }),
    marginBottom: 4,
  },
  macChipStats: {
    flexDirection: "row",
    gap: 8,
  },
  macChipCount: {
    color: "#5cd6ff",
    fontSize: 10,
    fontWeight: "700",
  },
  macChipDistance: {
    color: "#9aa4b2",
    fontSize: 10,
  },
  
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
  liveSearchTarget: { color: "#5cd6ff", fontSize: 10, marginBottom: 2 },
  liveStats: { flexDirection: "row", gap: 10 },
  liveStat: { color: "#9aa4b2", fontSize: 10 },
  liveStatValue: { color: "#5cd6ff", fontWeight: "700" },
  stopLiveBtn: { alignItems: "center", paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, backgroundColor: "rgba(255,107,107,0.15)", borderWidth: 1, borderColor: "#ff6b6b" },
  stopLiveText: { color: "#ff6b6b", fontSize: 9, fontWeight: "700", marginTop: 1 },
  
  // Devices section
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
  
  deviceLoading: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, paddingVertical: 8 },
  deviceLoadingText: { color: "#9aa4b2", fontSize: 12 },
  deviceErrorRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 8 },
  deviceErrorText: { color: "#ff6b6b", fontSize: 11 },
  noDevicesText: { color: "#7f8a99", fontSize: 11, marginTop: 6 },
  
  deviceRow: { 
    flexDirection: "row", 
    alignItems: "center", 
    paddingVertical: 10, 
    paddingHorizontal: 10, 
    marginTop: 8, 
    backgroundColor: "rgba(18,28,44,0.6)", 
    borderRadius: 8, 
    gap: 10 
  },
  deviceInfo: { flex: 1 },
  deviceName: { color: "#e6edf5", fontSize: 14, fontWeight: "600" },
  deviceId: { color: "#7f8a99", fontSize: 10, marginTop: 2 },
  deviceBtns: { flexDirection: "row", gap: 8 },
  
  deviceActionBtn: { 
    flexDirection: "row", 
    alignItems: "center", 
    gap: 4, 
    paddingHorizontal: 12, 
    paddingVertical: 8, 
    borderRadius: 6 
  },
  deviceActionText: { 
    fontSize: 12, 
    fontWeight: "700", 
    color: "#fff" 
  },
  btnLive: { 
    backgroundColor: "#ff3b30" 
  },
  btnBatch: { 
    backgroundColor: "#23b8f0" 
  },
  
  helpTextContainer: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: "rgba(92,214,255,0.1)",
  },
  helpText: {
    color: "#7f8a99",
    fontSize: 10,
    marginBottom: 2,
  },
  helpBold: {
    color: "#9aa4b2",
    fontWeight: "600",
  },
  
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