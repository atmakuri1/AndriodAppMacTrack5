// app/app/(tabs)/questionnaire.tsx
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
  getQuestionnaireResponses,
  createQuestionnaireResponse,
  QuestionnaireResponseRow,
  getMe,
} from "../../api";

export default function QuestionnaireScreen() {
  const [username, setUsername] = useState<string | null>(null);

  const [q1, setQ1] = useState("");
  const [q2, setQ2] = useState("");
  const [q3, setQ3] = useState("");
  const [q4, setQ4] = useState("");
  const [q5, setQ5] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [responses, setResponses] = useState<QuestionnaireResponseRow[]>([]);

  // Load current user + previous responses
  useEffect(() => {
    (async () => {
      try {
        const [me, data] = await Promise.all([
          getMe(),
          getQuestionnaireResponses(20),
        ]);
        setUsername(me.username);
        setResponses(data);
      } catch (e: any) {
        console.warn(e);
        Alert.alert("Error", e.message || "Failed to load questionnaire data");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const submit = async () => {
    if (!q1.trim() || !q2.trim() || !q3.trim() || !q4.trim() || !q5.trim()) {
      Alert.alert("Missing information", "Please fill in all fields before submitting.");
      return;
    }
    try {
      setSubmitting(true);
      const created = await createQuestionnaireResponse({
        respondent: username || "Unknown",  // 👈 auto-uses logged-in username
        q1: q1.trim(),
        q2: q2.trim(),
        q3: q3.trim(),
        q4: q4.trim(),
        q5: q5.trim(),
      });

      setResponses((prev) => [created, ...prev]);

      setQ1("");
      setQ2("");
      setQ3("");
      setQ4("");
      setQ5("");

      Alert.alert("Submitted", "Your questionnaire has been recorded.");
    } catch (e: any) {
      console.warn(e);
      Alert.alert("Error", e.message || "Failed to submit questionnaire");
    } finally {
      setSubmitting(false);
    }
  };

  const formatTs = (iso: string) => new Date(iso).toLocaleString();

  return (
    <SafeAreaView style={s.root}>
      <View style={s.headerLine} />
      <ScrollView style={s.content} keyboardShouldPersistTaps="handled">
        {/* Responder info banner */}
        <View style={s.responderBanner}>
          <Text style={s.responderLabel}>Responding as:</Text>
          <Text style={s.responderValue}>
            {username || "Loading…"}
          </Text>
        </View>

        {/* Questions 1–5 */}
        <Text style={s.qLabel}>1. How does the person look like?</Text>
        <View style={s.box}>
          <TextInput
            style={[s.input, s.multi]}
            value={q1}
            onChangeText={setQ1}
            placeholder="Enter your answer here"
            placeholderTextColor="#9aa4b2"
            multiline
          />
        </View>

        <Text style={s.qLabel}>2. What was the person wearing?</Text>
        <View style={s.box}>
          <TextInput
            style={[s.input, s.multi]}
            value={q2}
            onChangeText={setQ2}
            placeholder="Enter your answer here"
            placeholderTextColor="#9aa4b2"
            multiline
          />
        </View>

        <Text style={s.qLabel}>3. What direction did they go?</Text>
        <View style={s.box}>
          <TextInput
            style={[s.input, s.multi]}
            value={q3}
            onChangeText={setQ3}
            placeholder="Enter your answer here"
            placeholderTextColor="#9aa4b2"
            multiline
          />
        </View>

        <Text style={s.qLabel}>4. Any distinctive features?</Text>
        <View style={s.box}>
          <TextInput
            style={[s.input, s.multi]}
            value={q4}
            onChangeText={setQ4}
            placeholder="Enter your answer here"
            placeholderTextColor="#9aa4b2"
            multiline
          />
        </View>

        <Text style={s.qLabel}>5. Approximate age?</Text>
        <View style={s.box}>
          <TextInput
            style={[s.input, s.multi]}
            value={q5}
            onChangeText={setQ5}
            placeholder="Enter your answer here"
            placeholderTextColor="#9aa4b2"
            multiline
          />
        </View>

        {/* Submit button */}
        <Pressable onPress={submit} disabled={submitting} style={{ marginTop: 12 }}>
          <View style={[s.submitBtn, submitting && { opacity: 0.6 }]}>
            {submitting ? (
              <ActivityIndicator size="small" color="#0B1420" />
            ) : (
              <Text style={s.submitText}>Submit Questionnaire</Text>
            )}
          </View>
        </Pressable>

        {/* Recent responses */}
        <View style={{ marginTop: 24, marginBottom: 24 }}>
          <Text style={s.sectionTitle}>Recent Responses</Text>
          {loading ? (
            <ActivityIndicator size="small" color="#5cd6ff" />
          ) : responses.length === 0 ? (
            <Text style={s.empty}>No responses recorded yet.</Text>
          ) : (
            responses.map((r) => (
              <View key={r.id} style={s.card}>
                <Text style={s.cardTitle}>
                  {r.respondent || "Unknown"} · {formatTs(r.ts)}
                </Text>
                {/* 🔥 show full text, no truncation */}
                <Text style={s.cardLine}>Appearnece: {r.q1 || ""}</Text>
                <Text style={s.cardLine}>Attire: {r.q2 || ""}</Text>
                <Text style={s.cardLine}>Direction: {r.q3 || ""}</Text>
                <Text style={s.cardLine}>Features: {r.q4 || ""}</Text>
                <Text style={s.cardLine}>Age: {r.q5 || ""}</Text>
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

  responderBanner: {
    marginBottom: 16,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: "rgba(35,184,240,0.08)",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.2)",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  responderLabel: { color: "#9aa4b2", fontSize: 13 },
  responderValue: { color: "#5cd6ff", fontSize: 15, fontWeight: "700" },

  qLabel: { color: "#c9d5e3", fontSize: 14, marginTop: 8, marginBottom: 6 },

  box: {
    backgroundColor: "#0f1a2a",
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.25)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  input: {
    color: "#e6edf5",
    fontSize: 15,
  },
  multi: {
    minHeight: 50,
    textAlignVertical: "top",
  },

  submitBtn: {
    backgroundColor: "#23b8f0",
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: "center",
  },
  submitText: {
    color: "#0B1420",
    fontWeight: "700",
    fontSize: 16,
  },

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