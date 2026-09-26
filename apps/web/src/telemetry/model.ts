import { matchRoutes, type RouteObject } from "react-router-dom";
import { isRouteTemplate } from "@quizzy/shared";

/**
 * Какой экран открыт — шаблоном маршрута, а не адресом.
 *
 * Шаблон берётся из того же дерева маршрутов, по которому рисуется экран
 * (createRoutesFromChildren в TrackedRoutes), через matchRoutes — тот же
 * ранжир, что у самого маршрутизатора: `/patients/new` выигрывает у
 * `/patients/:userId`, как и при отрисовке. Отдельного списка шаблонов не
 * заводится: он разошёлся бы с App.tsx в день появления нового экрана, и
 * новый экран либо не считался бы, либо считался бы чужим именем.
 *
 * Из совпадений собираются ПУТИ маршрутов, а не куски адреса: в результат
 * попадает `:userId`, а не то, что стояло на его месте. Поэтому адрес с
 * идентификатором сюда не просочится по построению; isRouteTemplate сверху —
 * вторая дверь на случай маршрута, объявленного необычно.
 *
 * null — считать нечего: адрес не совпал ни с чем или совпал только с
 * перехватом «*», который тут же перенаправляет. Перенаправление — не экран.
 */
export function templateOf(routes: RouteObject[], pathname: string): string | null {
  const matches = matchRoutes(routes, pathname);
  if (!matches?.length) return null;
  if (matches[matches.length - 1]!.route.path === "*") return null;

  let parts: string[] = [];
  for (const m of matches) {
    const path = m.route.path;
    if (!path) continue; // index и раскладка без пути ничего не добавляют
    const own = path.split("/").filter(Boolean);
    // абсолютный путь вложенного маршрута уже содержит путь родителя
    parts = path.startsWith("/") ? own : [...parts, ...own];
  }
  const template = `/${parts.join("/")}`;
  return isRouteTemplate(template) ? template : null;
}

/* пачка — общая с кабинетом и мобильным приложением */
export { ScreenBatch } from "@quizzy/shared";
