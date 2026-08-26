import { Stack } from "expo-router";
import { useColors } from "@/theme";

/**
 * Аналитика — отдельный полноэкранный раздел вне вкладок: при входе панель вкладок
 * уходит, чтобы графики получали всю высоту экрана, и появляется своя навигация
 * список методик → дашборд → срезы → прохождение.
 */
export default function AnalyticsLayout() {
  const c = useColors();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: c.card },
        headerTitleStyle: { color: c.text },
        headerTintColor: c.primary,
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Аналитика" }} />
      <Stack.Screen name="[id]/index" options={{ title: "Методика" }} />
      <Stack.Screen name="[id]/responses" options={{ title: "Прохождения" }} />
      <Stack.Screen name="alerts" options={{ title: "Тревоги" }} />
      <Stack.Screen name="patients/index" options={{ title: "Пациенты" }} />
      <Stack.Screen name="patients/[userId]" options={{ title: "Динамика" }} />
    </Stack>
  );
}
