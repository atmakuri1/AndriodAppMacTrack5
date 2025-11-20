// app/app/(tabs)/observations.tsx
import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  Pressable,
  ScrollView,
  ActivityIndicator,
  Alert,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import {
  getObservations,
  createObservation,
  ObservationRow,
  getMe,
} from "../../api";

export default function ObservationsScreen() {
  const [username, setUsername] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [rows, setRows] = useState<ObservationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [me, data] = await Promise.all([
          getMe(),
          getObservations(100),
        ]);
        setUsername(me.username);
        setRows(data);
      } catch (e: any) {
        console.warn(e);
        Alert.alert("Error", e.message || "Failed to load data");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const submit = async () => {
    if (!note.trim()) return;
    try {
      setSubmitting(true);
      const created = await createObservation(
        username || "Unknown",
        note.trim()
      );
      setRows((prev) => [created, ...prev]);
      setNote("");
    } catch (e: any) {
      console.warn(e);
      Alert.alert("Error", e.message || "Failed to submit observation");
    } finally {
      setSubmitting(false);
    }
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerLine} />
      <ScrollView style={s.content} keyboardShouldPersistTaps="handled">
        {/* Observer info banner */}
        <View style={s.observerBanner}>
          <Text style={s.observerLabel}>Observing as:</Text>
          <Text style={s.observerValue}>
            {username || "Loading…"}
          </Text>
        </View>

        <Text style={s.label}>Observation</Text>
        <View style={s.box}>
          <TextInput
            style={[s.input, { minHeight: 90, textAlignVertical: "top" }]}
            value={note}
            onChangeText={setNote}
            placeholder="Enter your observation details"
            placeholderTextColor="#9aa4b2"
            multiline
          />
        </View>

        <Pressable
          onPress={submit}
          style={{ marginTop: 14 }}
          disabled={submitting}
        >
          <LinearGradient
            colors={["#1bc0f5", "#18a9d9"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={[s.cta, submitting && { opacity: 0.6 }]}
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#0B1420" />
            ) : (
              <Text style={s.ctaText}>Submit Observation</Text>
            )}
          </LinearGradient>
        </Pressable>

        <View style={{ marginTop: 24, marginBottom: 24 }}>
          <Text style={s.sectionTitle}>Recent Observations</Text>
          {loading ? (
            <ActivityIndicator size="small" color="#5cd6ff" />
          ) : rows.length === 0 ? (
            <Text style={s.empty}>No observations recorded yet</Text>
          ) : (
            rows.map((item) => (
              <View key={item.id} style={s.card}>
                <Text style={s.cardTitle}>
                  {item.full_name} · {formatDate(item.created_at)}
                </Text>
                <Text style={s.cardLine}>Observation: {item.observation_details}</Text>
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0b1420" },
  headerLine: { height: 1, backgroundColor: "rgba(92,214,255,0.12)" },
  content: { padding: 16 },
  
  observerBanner: {
    marginBottom: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "rgba(35,184,240,0.08)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.2)",
    flexDirection: "row",
    alignItems: "center",
  },
  observerLabel: { color: "#9aa4b2", fontSize: 13, marginRight: 8 },
  observerValue: { color: "#5cd6ff", fontSize: 15, fontWeight: "700" },
  
  label: { color: "#c9d5e3", fontSize: 13, marginBottom: 6 },
  box: {
    backgroundColor: "#0f1a2a",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  input: { color: "#e6edf5", fontSize: 15.5 },
  cta: { borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  ctaText: { color: "#0B1420", fontWeight: "700", fontSize: 16 },
  sectionTitle: { color: "#c9d5e3", fontSize: 15, fontWeight: "600" },
  empty: { color: "#9aa4b2", marginTop: 8 },
  card: {
    marginTop: 10,
    padding: 10,
    borderRadius: 10,
    backgroundColor: "rgba(18,28,44,0.9)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.18)",
  },
  cardTitle: { color: "#e6edf5", fontWeight: "600", marginBottom: 6 },
  cardLine: { color: "#9aa4b2", fontSize: 12, marginBottom: 2 },
});