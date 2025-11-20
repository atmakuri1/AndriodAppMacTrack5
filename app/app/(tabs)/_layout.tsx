import React from "react";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Alert, Platform, Pressable, Text } from "react-native";
import * as SecureStore from "expo-secure-store";

// 🔐 Logout button component
function LogoutButton() {
  const router = useRouter();

  const confirmLogout = () => {
    Alert.alert(
      "Log out?",
      "You will need to sign in again to access your account.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Log out",
          style: "destructive",
          onPress: async () => {
            await SecureStore.deleteItemAsync("token");
            router.replace("/login");
          },
        },
      ],
      { cancelable: true }
    );
  };

  return (
    <Pressable onPress={confirmLogout} hitSlop={8} style={{ paddingRight: 14 }}>
      <Text style={{ color: "#5cd6ff", fontWeight: "700" }}>Logout</Text>
    </Pressable>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      initialRouteName="map"
      screenOptions={{
        headerStyle: { backgroundColor: "#0b1420" },
        headerTintColor: "#5cd6ff",
        headerTitleStyle: { fontWeight: "bold" },
        headerRight: () => <LogoutButton />,
        tabBarStyle: {
          backgroundColor: "#0b1420",
          borderTopColor: "rgba(92,214,255,0.15)",
          height: Platform.select({ ios: 84, android: 64 }),
          paddingTop: 6,
        },
        tabBarActiveTintColor: "#5cd6ff",
        tabBarInactiveTintColor: "#8aa0b3",
      }}
    >
      {/* 👇 hide "index" so it doesn't appear as a tab */}
      <Tabs.Screen name="index" options={{ href: null }} />

      <Tabs.Screen
        name="map"
        options={{
          title: "Map",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons 
              name={focused ? "map" : "map-outline"} 
              color={color} 
              size={focused ? 26 : 24} 
            />
          ),
        }}
      />

      <Tabs.Screen
        name="detections"
        options={{
          title: "Detections",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons 
              name={focused ? "radio" : "radio-outline"} 
              color={color} 
              size={focused ? 26 : 24} 
            />
          ),
        }}
      />

      <Tabs.Screen
        name="eventlogs"
        options={{
          title: "Events",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons 
              name={focused ? "calendar" : "calendar-outline"} 
              color={color} 
              size={focused ? 26 : 24} 
            />
          ),
        }}
      />

      <Tabs.Screen
        name="observations"
        options={{
          title: "Observations",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons 
              name={focused ? "eye" : "eye-outline"} 
              color={color} 
              size={focused ? 26 : 24} 
            />
          ),
        }}
      />

      <Tabs.Screen
        name="questionnaire"
        options={{
          title: "Questionnaire",
          tabBarIcon: ({ color, size, focused }) => (
            <Ionicons 
              name={focused ? "document-text" : "document-text-outline"} 
              color={color} 
              size={focused ? 26 : 24} 
            />
          ),
        }}
      />
    </Tabs>
  );
}