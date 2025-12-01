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
            try {
              await SecureStore.deleteItemAsync("userToken");
            } catch (e) {
              // ignore errors clearing token
            }
            router.replace("/login");
          },
        },
      ]
    );
  };

  return (
    <Pressable
      onPress={confirmLogout}
      style={({ pressed }) => ({
        opacity: pressed ? 0.7 : 1,
        marginRight: 12,
        paddingHorizontal: 10,
        paddingVertical: Platform.OS === "ios" ? 6 : 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: "rgba(92,214,255,0.4)",
        justifyContent: "center",
        alignItems: "center",
      })}
    >
      <Text
        style={{
          color: "#5cd6ff",
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        Log out
      </Text>
    </Pressable>
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: "#0b1420",
          borderTopColor: "rgba(255,255,255,0.12)",
        },
        tabBarActiveTintColor: "#5cd6ff",
        tabBarInactiveTintColor: "#9BA4B5",
        headerStyle: {
          backgroundColor: "#0b1420",
        },
        headerTitleStyle: {
          color: "#e6edf5",
          fontSize: 20,
          fontWeight: "600",
        },
        headerTintColor: "#e6edf5",
        headerRight: () => <LogoutButton />,
      }}
    >
      {/* hide index so it doesn't appear as a tab */}
      <Tabs.Screen name="index" options={{ href: null }} />

      {/* MAP — custom in-screen header, so hide native header */}
      <Tabs.Screen
        name="map"
        options={{
          title: "Map",
          headerShown: false,
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "map" : "map-outline"}
              color={color}
              size={focused ? 26 : 24}
            />
          ),
        }}
      />

      {/* DETECTIONS */}
      <Tabs.Screen
        name="detections"
        options={{
          title: "Detections",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "radio" : "radio-outline"}
              color={color}
              size={focused ? 26 : 24}
            />
          ),
        }}
      />

      {/* EVENT LOGS */}
      <Tabs.Screen
        name="eventlogs"
        options={{
          title: "Event Logs",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "list" : "list-outline"}
              color={color}
              size={focused ? 26 : 24}
            />
          ),
        }}
      />

      {/* OBSERVATIONS */}
      <Tabs.Screen
        name="observations"
        options={{
          title: "Observations",
          tabBarIcon: ({ color, focused }) => (
            <Ionicons
              name={focused ? "eye" : "eye-outline"}
              color={color}
              size={focused ? 26 : 24}
            />
          ),
        }}
      />

      {/* QUESTIONNAIRE */}
      <Tabs.Screen
        name="questionnaire"
        options={{
          title: "Questionnaire",
          tabBarIcon: ({ color, focused }) => (
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
