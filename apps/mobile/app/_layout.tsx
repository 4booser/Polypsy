import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "@/auth/AuthContext";
import { useColors } from "@/theme";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <RootStack />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function RootStack() {
  const c = useColors();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // шапка должна следовать теме — иначе на тёмной теме она остаётся белой
        headerStyle: { backgroundColor: c.card },
        headerTitleStyle: { color: c.text },
        headerTintColor: c.primary,
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="index" />
      <Stack.Screen name="login" />
      <Stack.Screen name="register" />
      <Stack.Screen name="(app)" />
      <Stack.Screen name="survey/[id]" options={{ headerShown: true, title: "Методика" }} />
      <Stack.Screen name="analytics" />
    </Stack>
  );
}
