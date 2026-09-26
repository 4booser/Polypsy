import { Stack } from "expo-router";
import { useColors } from "@/theme";
import { useLang } from "@/lang";
import { ExitHeaderButton } from "@/nav/useExit";

/*
 * Корень раздела лежит под любым вложенным экраном.
 *
 * По ссылке (`quizzy://analytics/<методика>`, `…/patients/<id>`) раздел
 * открывался сразу вложенным экраном — единственным в стеке: ни стрелки, ни
 * корня, где есть выход. С якорем expo-router кладёт корень раздела под него,
 * и путь назад всегда один: вложенный → корень → вкладки.
 */
export const unstable_settings = { anchor: "index" };

/**
 * Аналитика — отдельный полноэкранный раздел вне вкладок: при входе панель вкладок
 * уходит, чтобы графики получали всю высоту экрана, и появляется своя навигация
 * список методик → дашборд → срезы → прохождение.
 */
export default function AnalyticsLayout() {
  const { ut } = useLang();
  const c = useColors();

  /*
   * Выход к вкладкам на корневом экране раздела.
   *
   * Вкладка «Аналитика» переадресовывала сюда заменой, поэтому возвращаться
   * стеку было некуда: системной стрелки «назад» нет, панель вкладок скрыта —
   * и приложение приходилось перезапускать. Теперь вкладка открывает раздел
   * поверх вкладок ((app)/_layout.tsx), и «‹ Меню» просто возвращает назад;
   * а если раздел открыт по ссылке и позади ничего нет — уводит к вкладкам
   * заменой (src/nav/exits.ts). Кнопка «назад» на Android делает то же
   * (useHardwareBackFallback в корневой раскладке).
   *
   * Подпись своя, а не системная стрелка: у группы вкладок нет имени, и
   * стрелка читалась бы «‹ (app)».
   */
  const closeButton = ({ canGoBack }: { canGoBack?: boolean }) => (
    <ExitHeaderButton canGoBack={!!canGoBack} always label={ut("ma.backToMenu")} accessibilityLabel={ut("mnav.exit")} />
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
      <Stack.Screen name="index" options={{ title: ut("mnav.analytics"), headerLeft: closeButton }} />
      <Stack.Screen name="[id]/index" options={{ title: ut("mnav.survey") }} />
      <Stack.Screen name="[id]/responses" options={{ title: ut("mnav.responses") }} />
      <Stack.Screen name="alerts" options={{ title: ut("mnav.alerts") }} />
      <Stack.Screen name="patients/index" options={{ title: ut("mnav.patients") }} />
      <Stack.Screen name="patients/[userId]" options={{ title: ut("msv.dynamics") }} />
    </Stack>
  );
}
