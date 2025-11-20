// app/event-devices.tsx
import React, { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { getEventDevices, EventDeviceSummary } from "../api";

export default function EventDevicesScreen() {
  const router = useRouter();
  const { eventId } = useLocalSearchParams<{ eventId: string }>();

  const [devices, setDevices] = useState<EventDeviceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!eventId) return;

    (async () => {
      try {
        const data = await getEventDevices(eventId);
        setDevices(data);
      } catch (e) {
        console.error("[EventDevices] failed to load devices:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [eventId]);

  if (!eventId) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <Text className="text-white">No event selected.</Text>
      </View>
    );
  }

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View className="flex-1 p-4 bg-black">
      <Text className="text-xl text-white mb-2">
        Devices in Event
      </Text>

      <FlatList
        data={devices}
        keyExtractor={(item) => item.mac_address}
        renderItem={({ item }) => (
          <TouchableOpacity
            className="mb-2 p-3 rounded-xl bg-zinc-900"
            onPress={() =>
              router.push({
                    pathname: "/(tabs)/detections",
                params: { eventId, mac: item.mac_address },
              })
            }
          >
            <Text className="text-white font-semibold">
              {item.mac_address}
            </Text>
            <Text className="text-zinc-400 text-sm">
              Detected {item.detection_count} times
            </Text>
            <Text className="text-zinc-500 text-xs">
              First: {new Date(item.first_seen).toLocaleString()}
            </Text>
            <Text className="text-zinc-500 text-xs">
              Last: {new Date(item.last_seen).toLocaleString()}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
