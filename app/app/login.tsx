// app/app/login.tsx
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { LinearGradient } from "expo-linear-gradient";
import { Ionicons } from "@expo/vector-icons";
import { Stack, router } from "expo-router";
import { login } from "../api";
import type { Href } from "expo-router";


export default function LoginScreen() {
  const [username, setUsername] = useState("");
  const [pwd, setPwd] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const canSubmit = username.trim().length > 0 && pwd.length > 0 && !loading;

  const onLogin = async () => {
    if (!canSubmit) return;
    setErr("");
    setLoading(true);
    try {
      await login(username.trim(), pwd); // call your Cloud Run API
      router.replace("/(tabs)/map" as Href);
    } catch (e: any) {
      setErr(e?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      {/* Hide default header */}
      <Stack.Screen options={{ headerShown: false }} />

      <SafeAreaView style={styles.container}>
        <KeyboardAvoidingView
          behavior={Platform.select({ ios: "padding", android: undefined })}
          style={{ width: "100%" }}
        >
          <View style={styles.card}>
            <Ionicons
              name="shield-checkmark-outline"
              size={44}
              color="#5cd6ff"
              style={{ alignSelf: "center" }}
            />
            <Text style={styles.title}>BluStick</Text>
            <Text style={styles.subtitle}>Sign in to your account</Text>

            <Text style={styles.label}>Email or Username</Text>
            <View style={styles.box}>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                placeholder="Enter your username"
                placeholderTextColor="#9aa4b2"
                autoCapitalize="none"
                autoCorrect={false}
                inputMode="email"
              />
            </View>

            <Text style={[styles.label, { marginTop: 10 }]}>Password</Text>
            <View
              style={[styles.box, { flexDirection: "row", alignItems: "center" }]}
            >
              <TextInput
                style={[styles.input, { flex: 1 }]}
                value={pwd}
                onChangeText={setPwd}
                placeholder="••••••••"
                placeholderTextColor="#9aa4b2"
                secureTextEntry={!show}
                autoCapitalize="none"
              />
              <Pressable onPress={() => setShow((s) => !s)} hitSlop={8}>
                <Ionicons
                  name={show ? "eye-off-outline" : "eye-outline"}
                  size={20}
                  color="#9aa4b2"
                />
              </Pressable>
            </View>

            {err ? <Text style={styles.error}>{err}</Text> : null}

            <Pressable
              onPress={onLogin}
              disabled={!canSubmit}
              style={{ marginTop: 18, opacity: canSubmit ? 1 : 0.7 }}
            >
              {({ pressed }) => (
                <LinearGradient
                  colors={
                    pressed
                      ? ["#1bb1e6", "#1aa2d1"]
                      : ["#1bc0f5", "#18a9d9"]
                  }
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 0 }}
                  style={styles.cta}
                >
                  {loading ? (
                    <ActivityIndicator />
                  ) : (
                    <Text style={styles.ctaText}>Continue</Text>
                  )}
                </LinearGradient>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b1420",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "rgba(18,28,44,0.9)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(92,214,255,0.15)",
    padding: 20,
  },
  title: {
    textAlign: "center",
    color: "#5cd6ff",
    fontSize: 28,
    fontWeight: "700",
    marginTop: 6,
  },
  subtitle: { textAlign: "center", color: "#b6c2d2", marginBottom: 18 },
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
  error: { color: "#ff6b6b", marginTop: 10 },
});
