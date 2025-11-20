// app/app/_layout.tsx
import React from "react";
import { Stack } from "expo-router";

export default function RootLayout() {
  return (
    <Stack>
      {/* login is full-screen, no header */}
      <Stack.Screen name="login" options={{ headerShown: false }} />

      {/* The tab navigator (contains map, detections, etc.) */}
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
