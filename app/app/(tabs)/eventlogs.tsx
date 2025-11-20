// app/(tabs)/eventlogs.tsx
import React, { useEffect, useState } from "react";
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator } from "react-native";
import { useRouter } from "expo-router";
import { getEvents, EventRow } from "../../api"; // <- note ../api

export default function EventsScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await getEvents(100);
        setEvents(data);
      } catch (e) {
        console.error("[Events] failed to load:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-black">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-black pt-4">
      <Text className="px-4 text-zinc-400 mb-2">
        Select an event to view detections
      </Text>

      <FlatList
        data={events}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity
            className="mx-4 mb-3 p-4 rounded-2xl bg-zinc-900"
            onPress={() =>
              router.push({
                pathname: "/event-devices",
                params: { eventId: item.id },
              })
            }
          >
            <Text className="text-white text-lg font-semibold">
              {item.event_name}
            </Text>
            {item.event_description && (
              <Text className="text-zinc-400 text-sm mt-1">
                {item.event_description}
              </Text>
            )}
            <Text className="text-xs text-cyan-400 mt-2">
              ID: {item.id}
            </Text>
            <Text className="text-xs text-zinc-500 mt-1">
              {new Date(item.created_at).toLocaleDateString()}
            </Text>
          </TouchableOpacity>
        )}
      />
    </View>
  );
}
