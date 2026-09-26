/**
 * Выход с экрана, позади которого ничего нет.
 *
 * Системная стрелка «назад» и кнопка Android работают, только пока в стеке
 * есть куда возвращаться. У части экранов бывает, что некуда: раздел
 * аналитики открывался заменой вкладки, прохождение после записи на приём —
 * заменой всего приложения, а по ссылке `quizzy://…` любой экран открывается
 * первым и единственным. Стрелки тогда нет, панель вкладок скрыта, кнопка
 * «назад» на Android сворачивает приложение — и человеку остаётся только
 * убить его. Ровно так выглядели две ловушки из внешнего разбора (аналитика
 * и согласие) и ещё три, найденные при повторной проверке.
 *
 * Правило одно: есть куда вернуться — возвращаемся; некуда — уходим на
 * известное место (fallbackOf), а не в никуда. Решение — чистая функция от
 * сегментов маршрута expo-router (`["analytics", "[id]"]`, как их отдаёт
 * useSegments) и признака «стек может вернуться»; исполняют его useExit и
 * обработчик кнопки «назад» (useExit.ts).
 *
 * Без react-native и expo-router — проверяется тестом, который заодно обходит
 * каталог app/ и требует запасной выход у каждого экрана вне вкладок.
 */

export type Exit = { kind: "back" } | { kind: "replace"; href: string };

/**
 * Куда уходить, если позади ничего нет. null — «это корень своего потока»:
 * с него уходят из приложения, и это правильно (вход, согласие, вкладки —
 * у вкладок своя панель, а «назад» на Android ведёт их к первой).
 */
export function fallbackOf(segments: readonly string[]): string | null {
  const [first, ...rest] = segments;
  switch (first) {
    case "analytics":
      // корень раздела — к вкладкам; вложенный экран — к корню раздела, где выход уже есть
      return rest.length === 0 ? "/(app)/surveys" : "/analytics";
    case "survey":
      return "/(app)/surveys";
    case "rounds":
      return "/(app)/rounds";
    case "register":
      return "/login";
    default:
      return null;
  }
}

export function exitFrom(segments: readonly string[], canGoBack: boolean): Exit | null {
  if (canGoBack) return { kind: "back" };
  const href = fallbackOf(segments);
  return href ? { kind: "replace", href } : null;
}

/**
 * Сегменты маршрута из пути файла в app/: `analytics/[id]/index.tsx` →
 * `["analytics", "[id]"]` — ровно то, что useSegments отдаёт на этом экране.
 * Раскладки (`_layout`) экранами не являются — null.
 */
export function segmentsOfRouteFile(path: string): string[] | null {
  const parts = path.replace(/\.tsx?$/, "").split("/").filter(Boolean);
  if (parts.at(-1) === "_layout") return null;
  if (parts.at(-1) === "index") parts.pop();
  return parts;
}
