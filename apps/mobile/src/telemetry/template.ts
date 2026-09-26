import { isRouteTemplate } from "@quizzy/shared";

/**
 * Шаблон экрана мобильного приложения из сегментов expo-router.
 *
 * useSegments отдаёт не адрес, а имена файлов маршрута: `["survey", "[id]"]`,
 * `["(app)", "surveys"]`. Из них шаблон собирается без единого значения из
 * адреса — ровно то, что нужно счётчику: `/survey/:id`, а не адрес
 * прохождения с идентификатором методики.
 *
 *   (app)       — группа раскладки, в адрес не входит: выбрасывается;
 *   [id]        — параметр: `:id`;
 *   [...rest]   — хвост: `*`;
 *   пусто       — корень: `/`.
 *
 * Итог прогоняется через ту же проверку, что на сервере (isRouteTemplate):
 * сегмент необычного вида не уйдёт, а не уйдёт молча — null.
 */
export function templateOfSegments(segments: readonly string[]): string | null {
  const parts = segments
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .map((s) => {
      if (s.startsWith("[...") && s.endsWith("]")) return "*";
      if (s.startsWith("[") && s.endsWith("]")) return `:${s.slice(1, -1)}`;
      return s;
    });
  const template = `/${parts.join("/")}`;
  return isRouteTemplate(template) ? template : null;
}
