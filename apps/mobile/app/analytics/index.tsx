import { Redirect } from "expo-router";

/**
 * Корень раздела /analytics — теперь вкладка «Аналітика» ((app)/insights.tsx).
 *
 * Адрес остаётся: по нему приходят ссылки, и на него уводит «назад» с
 * методики, открытой по ссылке первой (nav/exits.ts). Отсюда — на вкладку,
 * где сводка живёт вместе с панелью вкладок.
 */
export default function AnalyticsRoot() {
  return <Redirect href="/(app)/insights" />;
}
