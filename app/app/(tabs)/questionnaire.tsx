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

const QUESTIONS = [
  "How does the person look like?",
  "What was the person wearing?",
  "What direction did they go?",
  "Any distinctive features?",
  "Approximate age?",
];

export default function QuestionnaireScreen() {
  const [username, setUsername] = useState<string | null>(null);
  const [answers, setAnswers] = useState(["", "", "", "", ""]);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [responses, setResponses] = useState<QuestionnaireResponseRow[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const [me, data] = await Promise.all([getMe(), getQuestionnaireResponses(20)]);
        setUsername(me.username);
        setResponses(data);
      } catch (e: any) {
        Alert.alert("Error", e.message || "Failed to load data");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const updateAnswer = (idx: number, val: string) => {
    setAnswers(prev => prev.map((a, i) => (i === idx ? val : a)));
  };

  const submit = async () => {
    if (answers.some(a => !a.trim())) {
      Alert.alert("Missing", "Please fill in all fields.");
      return;
    }

    try {
      setSubmitting(true);
      const created = await createQuestionnaireResponse({
        respondent: username || "Unknown",
        q1: answers[0].trim(),
        q2: answers[1].trim(),
        q3: answers[2].trim(),
        q4: answers[3].trim(),
        q5: answers[4].trim(),
      });
      setResponses(prev => [created, ...prev]);
      setAnswers(["", "", "", "", ""]);
      Alert.alert("Submitted", "Questionnaire recorded.");
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
        <Text style={s.headerLabel}>User:</Text>
        <Text style={s.user}>{username || "..."}</Text>
      </View>

      <ScrollView style={s.content} keyboardShouldPersistTaps="handled">
        {QUESTIONS.map((q, i) => (
          <View key={i} style={s.field}>
            <Text style={s.questionLabel}>{i + 1}. {q}</Text>
            <TextInput
              style={s.input}
              value={answers[i]}
              onChangeText={t => updateAnswer(i, t)}
              placeholder="Your answer"
              placeholderTextColor="#5a6577"
              multiline
            />
          </View>
        ))}

        <Pressable onPress={submit} disabled={submitting} style={[s.btn, submitting && s.btnDisabled]}>
          {submitting ? (
            <ActivityIndicator size="small" color="#0a1018" />
          ) : (
            <Text style={s.btnText}>Submit</Text>
          )}
        </Pressable>

        <Text style={s.sectionLabel}>Recent ({responses.length})</Text>

        {loading ? (
          <ActivityIndicator color="#23b8f0" style={{ marginTop: 20 }} />
        ) : responses.length === 0 ? (
          <Text style={s.empty}>No responses yet</Text>
        ) : (
          responses.map(r => (
            <View key={r.id} style={s.card}>
              <View style={s.cardHeader}>
                <Text style={s.cardName}>{r.respondent || "Unknown"}</Text>
                <Text style={s.cardTime}>{formatTime(r.ts)}</Text>
              </View>
              <Text style={s.cardRow}>1. {r.q1}</Text>
              <Text style={s.cardRow}>2. {r.q2}</Text>
              <Text style={s.cardRow}>3. {r.q3}</Text>
              <Text style={s.cardRow}>4. {r.q4}</Text>
              <Text style={s.cardRow}>5. {r.q5}</Text>
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

  headerLabel: { color: "#5a6577", fontSize: 14 },
  user: { color: "#23b8f0", fontSize: 14, fontWeight: "600" },

  content: { padding: 16 },
  field: { marginBottom: 14 },

  questionLabel: { color: "#c9d5e3", fontSize: 13, marginBottom: 6 },

  input: {
    backgroundColor: "#111a24",
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "rgba(35,184,240,0.15)",
    padding: 10,
    color: "#e6edf5",
    fontSize: 14,
    minHeight: 44,
    textAlignVertical: "top",
  },

  btn: {
    backgroundColor: "#23b8f0",
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
    marginBottom: 24,
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
    marginBottom: 8,
  },

  cardName: { color: "#e6edf5", fontSize: 13, fontWeight: "600" },
  cardTime: { color: "#5a6577", fontSize: 11 },

  cardRow: { color: "#9aa4b2", fontSize: 12, marginBottom: 2 },
});
