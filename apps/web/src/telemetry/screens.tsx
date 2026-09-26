import { useEffect, useRef, type ReactNode } from "react";
import { createRoutesFromChildren, useLocation, useRoutes } from "react-router-dom";
import type { ScreenApp } from "@quizzy/shared";
import { api, tokenStore } from "../api";
import { ScreenBatch, templateOf } from "./model";

/**
 * Телеметрия открытия экранов: какой экран открыли, шаблоном маршрута.
 *
 * Решение заказчика 2026-09-26 (техпанель, «Використання»): видеть, какие
 * экраны открывают, — счётчиками по дню, без людей, адресов и текста.
 * Смотрит на это техпанель (/ops/usage), сервер — routes/opsData.ts.
 */

const batch = new ScreenBatch();
/** Раз в минуту — или раньше, если набралось: минута в счётчике по дням ничего не меняет */
const FLUSH_MS = 60_000;
const FLUSH_VIEWS = 40;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Отправить накопленное. Отказ глотается и пачка не возвращается: это
 * счётчик, а не клиническая запись, и повторять его ценой очереди в памяти и
 * лишних запросов незачем. Без токена — не отправляется вовсе: после выхода
 * запрос ушёл бы в отказ и попытку обмена сессии, ради счётчика.
 */
function flush(keepalive = false): void {
  const packs = batch.take();
  if (!packs.length || !tokenStore.get()) return;
  for (const pack of packs) void api.sendScreenViews(pack, keepalive).catch(() => {});
}

function onHide(): void {
  // вкладку закрывают или уводят в фон — последняя пачка уходит сейчас, с keepalive
  if (document.visibilityState === "hidden") flush(true);
}

/**
 * `<Routes>`, который считает открытые экраны.
 *
 * Делает ровно то же, что `<Routes>` маршрутизатора (useRoutes поверх
 * createRoutesFromChildren), и заодно знает дерево маршрутов — из него и
 * берётся шаблон. Отдельный хук снаружи дерева этого не мог бы: без
 * data-роутера useMatches недоступен, а угадывать шаблон по виду адреса
 * значит однажды принять идентификатор за слово.
 *
 * `enabled` выключает счёт для учётки «только просмотр»: её POST отвергается
 * до маршрута и пишется в журнал отказом (middleware/auth.ts) — строка
 * журнала в минуту от демонстрационной учётки была бы шумом.
 */
export function TrackedRoutes({
  app,
  enabled = true,
  children,
}: {
  app: ScreenApp;
  enabled?: boolean;
  children: ReactNode;
}) {
  const location = useLocation();
  const routes = createRoutesFromChildren(children);
  const routesRef = useRef(routes);
  routesRef.current = routes;

  useEffect(() => {
    if (!enabled) return;
    const template = templateOf(routesRef.current, location.pathname);
    if (!template) return;
    batch.add(app, template);
    if (batch.views() >= FLUSH_VIEWS) flush();
  }, [app, enabled, location.pathname]);

  useEffect(() => {
    if (!enabled) return;
    timer ??= setInterval(() => flush(), FLUSH_MS);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      // уходим (выход, смена оболочки) — накопленное уходит, пока токен ещё есть
      flush(true);
      if (timer) clearInterval(timer);
      timer = null;
    };
  }, [enabled]);

  return useRoutes(routes, location);
}
