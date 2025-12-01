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
        const [me, data] = await Promise.all([getMe(), getObservations(100)]);
        setUsername(me.username);
        setRows(data);
      } catch (e: any) {
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
      const created = await createObservation(username || "Unknown", note.trim());
      setRows((prev) => [created, ...prev]);
      setNote("");
    } catch (e: any) {
      Alert.alert("Error", e.message || "Failed to submit");
    } finally {
      setSubmitting(false);
    }
  };

  const formatTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  };

  return (
    <SafeAreaView style={s.root} edges={["left", "right", "bottom"]}>
      <View style={s.header}>
        <Text style={s.label}>User:</Text>
        <Text style={s.user}>{username || "..."}</Text>
      </View>

      <ScrollView style={s.content} keyboardShouldPersistTaps="handled">
        <View style={s.inputBox}>
          <TextInput
            style={s.input}
            value={note}
            onChangeText={setNote}
            placeholder="What did you observe?"
            placeholderTextColor="#5a6577"
            multiline
          />
        </View>

        <Pressable
          onPress={submit}
          disabled={submitting || !note.trim()}
          style={[s.btn, (submitting || !note.trim()) && s.btnDisabled]}
        >
          {submitting ? (
            <ActivityIndicator size="small" color="#0a1018" />
          ) : (
            <Text style={s.btnText}>Submit</Text>
          )}
        </Pressable>

        <Text style={s.sectionLabel}>Recent ({rows.length})</Text>

        {loading ? (
          <ActivityIndicator color="#23b8f0" style={{ marginTop: 20 }} />
        ) : rows.length === 0 ? (
          <Text style={s.empty}>No observations yet</Text>
        ) : (
          rows.map((item) => (
            <View key={item.id} style={s.card}>
              <View style={s.cardHeader}>
                <Text style={s.cardName}>{item.full_name}</Text>
                <Text style={s.cardTime}>{formatTime(item.created_at)}</Text>
              </View>
              <Text style={s.cardText}>{item.observation_details}</Text>
            </View>
          ))
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0a1018" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(35,184,240,0.1)",
    gap: 6,
  },
  label: { color: "#5a6577", fontSize: 14 },
  user: { color: "#23b8f0", fontSize: 14, fontWeight: "600" },
  content: { padding: 16 },
  inputBox: {
    backgroundColor: "#111a24",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(35,184,240,0.15)",
    padding: 12,
    marginBottom: 12,
  },
  input: {
    color: "#e6edf5",
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: "top",
  },
  btn: {
    backgroundColor: "#23b8f0",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 20,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: "#0a1018", fontWeight: "700", fontSize: 15 },
  sectionLabel: {
    color: "#5a6577",
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 10,
    textTransform: "uppercase",
  },
  empty: { color: "#5a6577", fontSize: 13 },
  card: {
    backgroundColor: "#111a24",
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(35,184,240,0.08)",
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  cardName: { color: "#e6edf5", fontSize: 13, fontWeight: "600" },
  cardTime: { color: "#5a6577", fontSize: 11 },
  cardText: { color: "#9aa4b2", fontSize: 13, lineHeight: 18 },
});