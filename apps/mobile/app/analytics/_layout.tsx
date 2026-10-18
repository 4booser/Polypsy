import { Stack } from "expo-router";
import { useColors } from "@/theme";
import { useLang } from "@/lang";

/**
 * Раздел /analytics — вложенные экраны сотрудника поверх вкладок:
 * методика (срезы и проходження) и карта пациента.
 *
 * Корня у раздела больше нет: сводка, сигналы и пацієнти — вкладки
 * ((app)/insights.tsx, alerts.tsx, patients.tsx), а прежние адреса
 * переадресуют туда. Поэтому и якоря нет: якорем был бы экран-переадресация,
 * и он увёл бы с методики, открытой по ссылке, раньше, чем её покажут.
 * Путь назад у вложенного экрана свой: «‹ Аналітика» и прочие ведут назад,
 * а если позади пусто — на вкладку (staff/ui.tsx, StaffNav → nav/exits.ts).
 *
 * Шапку экраны рисуют сами: под строкой навигации у них на полосе версия и
 * вкладки методики, поиск прохождений, человек с его возрастом.
 */
export default function AnalyticsLayout() {
  const { ut } = useLang();
  const c = useColors();
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: c.ground } }}>
      <Stack.Screen name="index" options={{ title: ut("mnav.analytics") }} />
      <Stack.Screen name="[id]/index" options={{ title: ut("mnav.survey") }} />
      <Stack.Screen name="[id]/responses" options={{ title: ut("mnav.responses") }} />
      <Stack.Screen name="alerts" options={{ title: ut("mst.tabAlerts") }} />
      <Stack.Screen name="patients/index" options={{ title: ut("mnav.patients") }} />
      <Stack.Screen name="patients/[userId]" options={{ title: ut("msv.dynamics") }} />
    </Stack>
  );
}
