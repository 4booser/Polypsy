import { Pressable, Text } from "react-native";
import { Stack, useRouter } from "expo-router";
import { spacing, useColors } from "@/theme";

/**
 * Аналитика — отдельный полноэкранный раздел вне вкладок: при входе панель вкладок
 * уходит, чтобы графики получали всю высоту экрана, и появляется своя навигация
 * список методик → дашборд → срезы → прохождение.
 */
export default function AnalyticsLayout() {
  const c = useColors();
  const router = useRouter();

  /*
   * Выход к вкладкам на корневом экране раздела.
   *
   * Вкладка «Аналитика» переадресует сюда заменой, поэтому возвращаться
   * стеку некуда: системной стрелки «назад» нет, панель вкладок скрыта — и
   * приложение приходилось перезапускать. Кнопка ставится только на корне;
   * на вложенных экранах стрелка появляется сама.
   */
  const closeButton = () => (
    <Pressable
      onPress={() => router.replace("/(app)/surveys")}
      accessibilityRole="button"
      accessibilityLabel="Выйти из аналитики"
      hitSlop={12}
      style={{ paddingRight: spacing.sm }}
    >
      <Text style={{ color: c.primary, fontSize: 16 }}>‹ Меню</Text>
    </Pressable>
  );

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: c.card },
        headerTitleStyle: { color: c.text },
        headerTintColor: c.primary,
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Аналитика", headerLeft: closeButton }} />
      <Stack.Screen name="[id]/index" options={{ title: "Методика" }} />
      <Stack.Screen name="[id]/responses" options={{ title: "Прохождения" }} />
      <Stack.Screen name="alerts" options={{ title: "Тревоги" }} />
      <Stack.Screen name="patients/index" options={{ title: "Пациенты" }} />
      <Stack.Screen name="patients/[userId]" options={{ title: "Динамика" }} />
    </Stack>
  );
}
