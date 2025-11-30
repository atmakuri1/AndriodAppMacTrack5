// app/(tabs)/detections.tsx
import React, { useEffect, useState, useCallback, useRef } from "react";
import { View, Text, FlatList, ActivityIndicator, Platform, Pressable, Alert, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { DetectionRow, getDetections, createDetectionsBatch } from "../../api";
import { collectDetectionsLive, stopLiveStream, scanForNearbyDevices, SimpleBleDevice, LiveStreamStatus } from "../../bleClient";
import * as SecureStore from "expo-secure-store";
import { PermissionsAndroid } from "react-native";
import { Ionicons } from "@expo/vector-icons";

const MONO = Platform.select({ ios: "Menlo", android: "monospace" });

const SignalBars = ({ rssi }: { rssi: number | null }) => {
  const bars = !rssi ? 0 : rssi >= -50 ? 4 : rssi >= -60 ? 3 : rssi >= -70 ? 2 : 1;
  const color = bars >= 3 ? "#4cd964" : bars === 2 ? "#ffcc00" : "#ff9500";
  return (
    <View style={s.signalBars}>
      {[1,2,3,4].map(i => <View key={i} style={[s.bar, {height: i*3+3, backgroundColor: i<=bars ? color : "#2a3b4c"}]} />)}
      <Text style={s.rssi}>{rssi ?? "—"}</Text>
    </View>
  );
};

export default function DetectionsScreen() {
  const router = useRouter();
  const { mac: macFromParams } = useLocalSearchParams<{ mac?: string }>();

  const [detections, setDetections] = useState<DetectionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filterMac, setFilterMac] = useState<string | undefined>(macFromParams);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<SimpleBleDevice[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [liveDevice, setLiveDevice] = useState<SimpleBleDevice | null>(null);
  const [liveStatus, setLiveStatus] = useState<LiveStreamStatus>({isStreaming:false,detectionCount:0,uploadedCount:0,errorCount:0,pendingCount:0,lastDetection:null});
  const [recentMacs, setRecentMacs] = useState(new Map());
  const [trackingMac, setTrackingMac] = useState<string | null>(null);
  const [stats, setStats] = useState({received:0,uploaded:0,filtered:0,tracked:0});

  const liveRef = useRef(false);
  const recentRef = useRef(new Map());
  const trackRef = useRef<string|null>(null);
  const statsRef = useRef({received:0,uploaded:0,filtered:0,tracked:0});

  const load = async (mac?: string) => {
    try {
      setError("");
      setLoading(true);
      setDetections(await getDetections({mac_address:mac,limit:100}));
    } catch (e: any) {
      setError(e?.message || "Failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(filterMac); }, [filterMac]);
  useEffect(() => { if (macFromParams && macFromParams !== filterMac) setFilterMac(macFromParams); }, [macFromParams]);
  useEffect(() => () => { if (liveRef.current) try { stopLiveStream(); } catch {} }, []);

  const scan = async () => {
    try {
      setScanning(true);
      if (Platform.OS === "android" && Platform.Version >= 31) {
        const g = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        if (!Object.values(g).every(v => v === "granted")) { Alert.alert("Error","Permissions required"); return; }
      }
      const list = await scanForNearbyDevices(8000);
      setDevices(list);
      if (!list.length) Alert.alert("No Devices","No BluStick found");
    } catch (e: any) {
      Alert.alert("Scan Failed", e?.message);
    } finally {
      setScanning(false);
    }
  };

  const startLive = async (device: SimpleBleDevice) => {
    const token = await SecureStore.getItemAsync("token");
    if (!token) { Alert.alert("Error","Not authenticated"); return; }

    setIsLive(true);
    setLiveDevice(device);
    liveRef.current = true;
    recentRef.current = new Map();
    setRecentMacs(new Map());
    setTrackingMac(null);
    trackRef.current = null;
    statsRef.current = {received:0,uploaded:0,filtered:0,tracked:0};
    setStats({received:0,uploaded:0,filtered:0,tracked:0});
    setLiveStatus({isStreaming:true,detectionCount:0,uploadedCount:0,errorCount:0,pendingCount:0,lastDetection:null});

    try {
      await collectDetectionsLive(
        null,
        async (batch) => {
          statsRef.current.received += batch.length;
          setStats({...statsRef.current});

          let upload = batch;
          const target = trackRef.current;
          if (target) {
            upload = batch.filter(d => d.mac_address?.toUpperCase() === target.toUpperCase());
            statsRef.current.filtered += batch.length - upload.length;
            if (upload.length) statsRef.current.tracked += upload.length;
            setStats({...statsRef.current});
          }

          if (upload.length) {
            await createDetectionsBatch(upload);
            statsRef.current.uploaded += upload.length;
            setStats({...statsRef.current});
            load(filterMac);
          }
        },
        (status) => {
          setLiveStatus(status);
          if (status.lastDetection) {
            const {mac_address:mac,rssi,estimated_distance:dist} = status.lastDetection;
            const e = recentRef.current.get(mac);
            if (e) { e.count++; e.lastRssi=rssi; e.lastDistance=dist; e.lastSeen=new Date(); }
            else recentRef.current.set(mac,{mac,count:1,lastRssi:rssi,lastDistance:dist,lastSeen:new Date()});
            if (status.detectionCount % 3 === 0) setRecentMacs(new Map(recentRef.current));
          }
        },
        {deviceId:device.id,timeoutMs:0}
      );
      
      const track = trackRef.current;
      const lines = [`Received: ${statsRef.current.received}`,`Uploaded: ${statsRef.current.uploaded}`,`Unique: ${recentRef.current.size}`];
      if (track) lines.push(`\nTracking: ${track}`,`Tracked: ${statsRef.current.tracked}`,`Filtered: ${statsRef.current.filtered}`);
      if (liveStatus.errorCount) lines.push(`\nErrors: ${liveStatus.errorCount}`);
      Alert.alert("Stream Ended", lines.join('\n'));
      await load(filterMac);
      setDevices([]);
    } catch (e: any) {
      Alert.alert("Error", e?.message);
    } finally {
      setIsLive(false);
      setLiveDevice(null);
      liveRef.current = false;
      setTrackingMac(null);
      trackRef.current = null;
      setRecentMacs(new Map());
      recentRef.current = new Map();
    }
  };

  const stopLive = () => {
    Alert.alert("Stop?", trackRef.current ? `Stop tracking ${trackRef.current}?` : "End stream?", [
      {text:"Cancel",style:"cancel"},
      {text:"Stop",style:"destructive",onPress:() => {try{stopLiveStream();liveRef.current=false;}catch{}}}
    ]);
  };

  const track = (mac:string) => {
    const norm = mac.toUpperCase();
    trackRef.current = norm;
    setTrackingMac(norm);
    statsRef.current.tracked = statsRef.current.filtered = 0;
    setStats({...statsRef.current});
  };

  const untrack = () => { trackRef.current = null; setTrackingMac(null); };
  const recent = () => Array.from(recentMacs.values()).filter(m => m.lastSeen.getTime() >= Date.now()-600000).sort((a,b)=>b.count-a.count).slice(0,12);

  const renderItem = useCallback(({item}: {item:DetectionRow}) => (
    <View style={s.card}>
      <View style={s.row}>
        <Text style={[s.mac,{fontFamily:MONO}]}>{item.mac_address??"unknown"}</Text>
        {item.signal_type && <View style={s.badge}><Text style={s.badgeText}>{item.signal_type}</Text></View>}
      </View>
      <View style={s.stats}>
        <SignalBars rssi={item.rssi} />
        <Text style={s.stat}>{item.estimated_distance?.toFixed(1)??"—"}m</Text>
        <Text style={s.stat}>{new Date(item.detected_at).toLocaleTimeString()}</Text>
      </View>
    </View>
  ), []);

  const recentList = recent();

  return (
    <SafeAreaView style={s.root}>
      <View style={s.div} />
      <FlatList
        data={detections}
        keyExtractor={(item,idx) => `${item.mac_address}-${item.detected_at}-${idx}`}
        renderItem={renderItem}
        contentContainerStyle={s.list}
        ItemSeparatorComponent={() => <View style={{height:8}} />}
        ListHeaderComponent={<>
          {isLive && liveDevice && (
            <View style={s.liveBox}>
              <View style={s.liveHead}>
                <View style={s.liveBadge}><View style={s.dot} /><Text style={s.liveTxt}>LIVE</Text></View>
                <Text style={s.liveDev}>{liveDevice.name??liveDevice.id}</Text>
                <Pressable onPress={stopLive} style={s.stop}><Ionicons name="stop" size={16} color="#fff" /></Pressable>
              </View>

              {trackingMac ? (
                <View style={s.liveStats}>
                  <View style={s.liveStat}><Text style={s.num}>{stats.received}</Text><Text style={s.lbl}>Received</Text></View>
                  <View style={[s.liveStat,{backgroundColor:"rgba(76,217,100,0.15)"}]}><Text style={[s.num,{color:"#4cd964"}]}>{stats.tracked}</Text><Text style={s.lbl}>Tracked</Text></View>
                  <View style={[s.liveStat,{backgroundColor:"rgba(255,149,0,0.15)"}]}><Text style={[s.num,{color:"#ff9500"}]}>{stats.filtered}</Text><Text style={s.lbl}>Filtered</Text></View>
                  <View style={s.liveStat}><Text style={s.num}>{stats.uploaded}</Text><Text style={s.lbl}>Uploaded</Text></View>
                </View>
              ) : (
                <View style={s.liveStats}>
                  <View style={s.liveStat}><Text style={s.num}>{liveStatus.detectionCount}</Text><Text style={s.lbl}>Received</Text></View>
                  <View style={s.liveStat}><Text style={s.num}>{liveStatus.uploadedCount}</Text><Text style={s.lbl}>Uploaded</Text></View>
                  <View style={s.liveStat}><Text style={s.num}>{recentMacs.size}</Text><Text style={s.lbl}>Unique</Text></View>
                </View>
              )}

              {trackingMac ? (
                <View style={s.trackPanel}>
                  <View style={s.trackHead}>
                    <View style={s.trackInd}><View style={s.pulse} /></View>
                    <View style={{flex:1}}>
                      <Text style={s.trackTitle}>TRACKING</Text>
                      <Text style={[s.trackMac,{fontFamily:MONO}]}>{trackingMac}</Text>
                    </View>
                  </View>
                  <Text style={s.trackInfo}>Only this device is uploaded. Others filtered.</Text>
                  <View style={s.trackAct}>
                    <Pressable style={s.mapBtn} onPress={()=>router.push({pathname:"/(tabs)/map" as any,params:{mac:trackingMac}})}>
                      <Ionicons name="map" size={14} color="#fff" />
                      <Text style={s.mapTxt}>Map</Text>
                    </Pressable>
                    <Pressable style={s.stopTrack} onPress={untrack}>
                      <Ionicons name="close" size={14} color="#fff" />
                      <Text style={s.stopTxt}>Stop</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={s.recentSec}>
                  <Text style={s.recentTitle}>Tap to track exclusively</Text>
                  {!recentList.length ? <Text style={s.wait}>Waiting...</Text> : recentList.map(m => (
                    <Pressable key={m.mac} style={s.recentItem} onPress={()=>track(m.mac)}>
                      <View style={{flex:1}}>
                        <Text style={[s.recentMac,{fontFamily:MONO}]}>{m.mac}</Text>
                        <Text style={s.recentStat}>{m.count}× • {m.lastRssi??"—"} dBm • {m.lastDistance?.toFixed(1)??"—"}m</Text>
                      </View>
                      <View style={s.trackBtn}><Ionicons name="locate" size={14} color="#0b1420" /><Text style={s.trackBtnTxt}>Track</Text></View>
                    </Pressable>
                  ))}
                </View>
              )}
            </View>
          )}

          {!isLive && (
            <View style={s.scanSec}>
              <View style={s.scanHead}><Ionicons name="bluetooth" size={16} color="#5cd6ff" /><Text style={s.scanTitle}>Connect BluStick</Text></View>
              <View style={s.scanAct}>
                <Pressable style={[s.scanBtn,scanning&&s.dis]} onPress={scan} disabled={scanning}>
                  {scanning ? <ActivityIndicator size="small" color="#0b1420" /> : <Ionicons name="search" size={14} color="#0b1420" />}
                  <Text style={s.scanTxt}>{scanning?"Scanning...":"Scan"}</Text>
                </Pressable>
                <Pressable style={s.refresh} onPress={()=>load(filterMac)}><Ionicons name="refresh" size={16} color="#5cd6ff" /></Pressable>
                {filterMac && <Pressable style={s.refresh} onPress={()=>router.push({pathname:"/(tabs)/map" as any,params:{mac:filterMac}})}><Ionicons name="map" size={16} color="#5cd6ff" /></Pressable>}
              </View>
              {devices.length>0 && (
                <View style={s.devList}>
                  {devices.map(d => (
                    <View key={d.id} style={s.devItem}>
                      <Ionicons name="hardware-chip" size={18} color="#5cd6ff" />
                      <View style={{flex:1}}>
                        <Text style={s.devName}>{d.name??"BluStick"}</Text>
                        <Text style={s.devId}>{d.id}</Text>
                      </View>
                      <Pressable style={s.liveBtn} onPress={()=>startLive(d)}><Ionicons name="radio" size={12} color="#fff" /><Text style={s.liveBtnTxt}>Live</Text></Pressable>
                    </View>
                  ))}
                </View>
              )}
            </View>
          )}

          <View style={s.filterBar}>
            {filterMac ? (
              <View style={s.filterActive}>
                <Ionicons name="filter" size={12} color="#5cd6ff" />
                <Text style={s.filterTxt} numberOfLines={1}>{filterMac}</Text>
                <Pressable onPress={()=>setFilterMac(undefined)} style={s.clear}><Ionicons name="close" size={14} color="#ff6b6b" /></Pressable>
              </View>
            ) : <Text style={s.filterLbl}>All detections</Text>}
            <View style={s.cnt}><Text style={s.cntTxt}>{detections.length}</Text></View>
          </View>
        </>}
        ListEmptyComponent={loading ? <View style={s.ctr}><ActivityIndicator size="large" color="#5cd6ff" /></View> : error ? (
          <View style={s.ctr}><Ionicons name="alert-circle" size={44} color="#ff6b6b" /><Text style={s.err}>{error}</Text><Pressable style={s.retry} onPress={()=>load(filterMac)}><Text style={s.retryTxt}>Retry</Text></Pressable></View>
        ) : (
          <View style={s.ctr}><Ionicons name="radio-outline" size={52} color="#3a4b5c" /><Text style={s.empty}>No Detections</Text><Text style={s.emptySub}>{filterMac?"No detections for this device":"Connect a BluStick to start"}</Text></View>
        )}
      />
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:{flex:1,backgroundColor:"#0b1420"},div:{height:1,backgroundColor:"rgba(92,214,255,0.12)"},list:{padding:12},
  signalBars:{flexDirection:"row",alignItems:"flex-end",gap:2},bar:{width:3,borderRadius:1},rssi:{color:"#7f8a99",fontSize:10,marginLeft:4},
  card:{backgroundColor:"rgba(18,28,44,0.9)",borderRadius:8,padding:12,borderWidth:1,borderColor:"rgba(92,214,255,0.15)"},
  row:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",marginBottom:8},
  mac:{color:"#e6edf5",fontWeight:"700",fontSize:13},badge:{backgroundColor:"rgba(92,214,255,0.15)",paddingHorizontal:6,paddingVertical:2,borderRadius:4},
  badgeText:{color:"#5cd6ff",fontSize:9,fontWeight:"600"},stats:{flexDirection:"row",alignItems:"center",gap:12},stat:{color:"#9aa4b2",fontSize:11},
  liveBox:{backgroundColor:"rgba(255,59,48,0.08)",borderWidth:2,borderColor:"#ff3b30",borderRadius:12,marginBottom:12,overflow:"hidden"},
  liveHead:{flexDirection:"row",alignItems:"center",padding:10,backgroundColor:"rgba(255,59,48,0.15)",gap:8},
  liveBadge:{flexDirection:"row",alignItems:"center",gap:4,backgroundColor:"#ff3b30",paddingHorizontal:8,paddingVertical:4,borderRadius:4},
  dot:{width:6,height:6,borderRadius:3,backgroundColor:"#fff"},liveTxt:{color:"#fff",fontSize:10,fontWeight:"800"},
  liveDev:{flex:1,color:"#e6edf5",fontSize:13,fontWeight:"600"},stop:{width:32,height:32,borderRadius:16,backgroundColor:"rgba(255,107,107,0.3)",alignItems:"center",justifyContent:"center"},
  liveStats:{flexDirection:"row",padding:10,gap:6},liveStat:{flex:1,alignItems:"center",backgroundColor:"rgba(18,28,44,0.5)",paddingVertical:8,borderRadius:6},
  num:{color:"#5cd6ff",fontSize:18,fontWeight:"800"},lbl:{color:"#7f8a99",fontSize:9,marginTop:2},
  trackPanel:{backgroundColor:"#4cd964",margin:10,marginTop:0,padding:14,borderRadius:10},
  trackHead:{flexDirection:"row",alignItems:"center",gap:10,marginBottom:8},
  trackInd:{width:32,height:32,borderRadius:16,backgroundColor:"rgba(255,255,255,0.25)",alignItems:"center",justifyContent:"center"},
  pulse:{width:12,height:12,borderRadius:6,backgroundColor:"#fff"},trackTitle:{color:"rgba(255,255,255,0.8)",fontSize:10,fontWeight:"700",letterSpacing:1},
  trackMac:{color:"#fff",fontSize:15,fontWeight:"800",marginTop:2},trackInfo:{color:"rgba(255,255,255,0.85)",fontSize:11,marginBottom:12,lineHeight:16},
  trackAct:{flexDirection:"row",gap:8},mapBtn:{flex:1,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:6,backgroundColor:"rgba(0,0,0,0.2)",paddingVertical:10,borderRadius:6},
  mapTxt:{color:"#fff",fontSize:13,fontWeight:"700"},stopTrack:{flexDirection:"row",alignItems:"center",gap:4,paddingHorizontal:14,backgroundColor:"rgba(0,0,0,0.15)",borderRadius:6},
  stopTxt:{color:"#fff",fontSize:13,fontWeight:"600"},
  recentSec:{padding:10},recentTitle:{color:"#9aa4b2",fontSize:11,marginBottom:8,textAlign:"center"},wait:{color:"#5a6a7a",fontSize:12,textAlign:"center",paddingVertical:16},
  recentItem:{flexDirection:"row",alignItems:"center",backgroundColor:"rgba(18,28,44,0.6)",padding:10,borderRadius:8,marginBottom:6},
  recentMac:{color:"#e6edf5",fontSize:12,fontWeight:"600"},recentStat:{color:"#7f8a99",fontSize:10,marginTop:2},
  trackBtn:{flexDirection:"row",alignItems:"center",gap:4,backgroundColor:"#5cd6ff",paddingHorizontal:10,paddingVertical:6,borderRadius:5},
  trackBtnTxt:{color:"#0b1420",fontSize:11,fontWeight:"700"},
  scanSec:{backgroundColor:"rgba(18,28,44,0.9)",borderRadius:10,padding:12,marginBottom:12,borderWidth:1,borderColor:"rgba(92,214,255,0.15)"},
  scanHead:{flexDirection:"row",alignItems:"center",gap:6,marginBottom:10},scanTitle:{color:"#c9d5e3",fontSize:13,fontWeight:"600"},
  scanAct:{flexDirection:"row",gap:8},scanBtn:{flex:1,flexDirection:"row",alignItems:"center",justifyContent:"center",gap:6,backgroundColor:"#23b8f0",paddingVertical:10,borderRadius:8},
  scanTxt:{color:"#0b1420",fontSize:14,fontWeight:"700"},dis:{opacity:0.6},
  refresh:{width:44,alignItems:"center",justifyContent:"center",backgroundColor:"rgba(92,214,255,0.1)",borderRadius:8,borderWidth:1,borderColor:"rgba(92,214,255,0.3)"},
  devList:{marginTop:10},devItem:{flexDirection:"row",alignItems:"center",backgroundColor:"rgba(10,18,32,0.8)",padding:10,borderRadius:8,marginBottom:6,gap:10},
  devName:{color:"#e6edf5",fontSize:13,fontWeight:"600"},devId:{color:"#7f8a99",fontSize:9,marginTop:2},
  liveBtn:{flexDirection:"row",alignItems:"center",gap:4,backgroundColor:"#ff3b30",paddingHorizontal:12,paddingVertical:8,borderRadius:6},
  liveBtnTxt:{color:"#fff",fontSize:12,fontWeight:"700"},
  filterBar:{flexDirection:"row",justifyContent:"space-between",alignItems:"center",paddingHorizontal:4,paddingVertical:8,marginBottom:8},
  filterLbl:{color:"#9aa4b2",fontSize:12},filterActive:{flexDirection:"row",alignItems:"center",gap:6,backgroundColor:"rgba(92,214,255,0.1)",paddingHorizontal:10,paddingVertical:5,borderRadius:6,flex:1,marginRight:10},
  filterTxt:{color:"#5cd6ff",fontSize:12,fontWeight:"600",flex:1},clear:{padding:2},cnt:{backgroundColor:"rgba(92,214,255,0.15)",paddingHorizontal:8,paddingVertical:3,borderRadius:10},
  cntTxt:{color:"#5cd6ff",fontSize:11,fontWeight:"700"},
  ctr:{alignItems:"center",paddingVertical:40,gap:10},err:{color:"#ff6b6b",fontSize:13},retry:{paddingHorizontal:20,paddingVertical:10,backgroundColor:"rgba(92,214,255,0.1)",borderRadius:8,marginTop:8},
  retryTxt:{color:"#5cd6ff",fontWeight:"600"},empty:{color:"#e6edf5",fontSize:16,fontWeight:"700"},emptySub:{color:"#7f8a99",fontSize:12,textAlign:"center"},
});