// app/app/(tabs)/index.tsx
import { Redirect } from "expo-router";

export default function TabsIndex() {
  // send users to the first tab
  return <Redirect href="/(tabs)/map" />;
}
