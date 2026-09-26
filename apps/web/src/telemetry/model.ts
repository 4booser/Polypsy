import { matchRoutes, type RouteObject } from "react-router-dom";
import {
  RUM_SAMPLE_RATE,
  coarseBrowser,
  coarseOs,
  isRouteTemplate,
  maskText,
  routeTemplate,
  type ClientErrorInput,
  type ClientErrorKind,
} from "@quizzy/shared";

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

/* ═══════════ ошибки клиента и скорость экранов (участок obs2b) ═══════════ */

/**
 * Чистая логика телеметрии консоли: что считать ошибкой и что сбоем сети,
 * как копить сдвиги макета (CLS), задержку отклика (INP) и «экран
 * успокоился» после перехода. Без браузера и без «сейчас» внутри — время
 * приходит аргументом (apps/web/test/opsObs2b.test.ts). Обвязка с
 * PerformanceObserver и таймерами — client.ts.
 */

/* ─────────── выборка ─────────── */

/**
 * Меряется ли эта сессия: решение принимается один раз и хранится в
 * sessionStorage, иначе каждая перезагрузка бросала бы жребий заново и
 * выборка смещалась бы к тем, кто чаще перезагружает.
 */
export function sampleDecision(stored: string | null, rnd: number, rate = RUM_SAMPLE_RATE): { on: boolean; store: string | null } {
  if (stored === "1") return { on: true, store: null };
  if (stored === "0") return { on: false, store: null };
  const on = rnd < rate;
  return { on, store: on ? "1" : "0" };
}

/* ─────────── ошибки ─────────── */

export interface ErrorContext {
  route: string;
  release: string | undefined;
  ua: string;
}

/*
 * Шум браузера, а не наша ошибка: ResizeObserver сообщает о пропущенном
 * кадре, «Script error.» — чужой скрипт с другого источника без подробностей.
 */
const NOISE = [/ResizeObserver loop/i, /^Script error\.?$/i];

/** Статус сетевого отказа (ApiError): его уже учёл сетевой клиент, второй раз не шлём */
function apiStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return null;
}

/** Ошибка → строка к отправке; null — не наша забота (шум, отказ API) */
export function errorInput(err: unknown, kind: ClientErrorKind, ctx: ErrorContext, extraStack?: string): ClientErrorInput | null {
  /*
   * Отказ API — не падение экрана. 4xx — бизнес-логика («нет прав», «уже
   * сдано»), и сообщать о ней как об ошибке значило бы завалить раздел
   * поведением людей; 5xx и сеть сетевой клиент уже прислал сам.
   */
  if (apiStatus(err) !== null) return null;
  let name = "Error";
  let message = "";
  let stack: string | undefined;
  if (err instanceof Error) {
    name = err.name || "Error";
    message = err.message;
    stack = err.stack;
  } else if (typeof err === "string") {
    message = err;
  } else if (err !== null && err !== undefined) {
    name = typeof err;
  }
  if (NOISE.some((re) => re.test(message))) return null;
  const fullStack = [stack, extraStack].filter(Boolean).join("\n");
  return {
    platform: "web",
    kind,
    name: maskText(name, 80),
    message: maskText(message, 500),
    ...(fullStack ? { stack: maskText(fullStack, 4000) } : {}),
    route: routeTemplate(ctx.route),
    ...(ctx.release ? { release: ctx.release } : {}),
    ...coarse(ctx.ua),
  };
}

function coarse(ua: string): { browser?: string; os?: string } {
  const browser = coarseBrowser(ua);
  const os = coarseOs(ua);
  return { ...(browser ? { browser } : {}), ...(os ? { os } : {}) };
}

/**
 * Сетевой сбой, о котором стоит знать: пятисотка — всегда, «не дошли» —
 * только когда браузер считает себя в сети. Ноутбук, потерявший Wi-Fi в
 * коридоре, — не сбой системы, а коридор.
 */
export function isReportableFailure(status: number, online: boolean): boolean {
  return status >= 500 || (status === 0 && online);
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

export function networkInput(
  f: { method: string; path: string; status: number },
  online: boolean,
  ctx: ErrorContext,
): ClientErrorInput | null {
  if (!isReportableFailure(f.status, online)) return null;
  const apiRoute = routeTemplate(f.path);
  /* сама телеметрия о себе не сообщает: сбой отправки ошибки породил бы ошибку отправки */
  if (apiRoute.startsWith("/api/ops/client-errors") || apiRoute.startsWith("/api/ops/vitals")) return null;
  const method = f.method.toUpperCase();
  return {
    platform: "web",
    kind: "network",
    name: f.status === 0 ? "NetworkError" : `HTTP ${f.status}`,
    message: "",
    route: routeTemplate(ctx.route),
    ...(METHODS.has(method) ? { apiMethod: method } : {}),
    apiRoute,
    status: f.status,
    ...(ctx.release ? { release: ctx.release } : {}),
    ...coarse(ctx.ua),
  };
}

/* ─────────── CLS ─────────── */

/**
 * Сдвиги макета по окнам сессий, как считает Web Vitals: сдвиги ближе
 * секунды друг к другу и не дольше пяти секунд подряд — одно окно; CLS —
 * самое тяжёлое окно. Сдвиг сразу после ввода человека не считается: его
 * человек ждал (раскрыл список — список раскрылся).
 */
export class ClsAccumulator {
  private windowValue = 0;
  private windowStart = -Infinity;
  private last = -Infinity;
  private worst = 0;
  private seen = false;

  add(value: number, time: number, hadRecentInput: boolean): void {
    if (hadRecentInput) return;
    this.seen = true;
    if (time - this.last < 1000 && time - this.windowStart < 5000) {
      this.windowValue += value;
    } else {
      this.windowValue = value;
      this.windowStart = time;
    }
    this.last = time;
    if (this.windowValue > this.worst) this.worst = this.windowValue;
  }

  /** null — сдвигов не было вовсе; это «0», но и замера как такового нет */
  get value(): number | null {
    return this.seen ? this.worst : null;
  }
}

/* ─────────── INP ─────────── */

/**
 * Задержка отклика экрана: у взаимодействия (нажатие, клавиша) — самая
 * долгая из его событий; у экрана — худшее взаимодействие, а при частых —
 * почти худшее (одно на каждые пятьдесят отбрасывается), как в Web Vitals.
 */
export class InpAccumulator {
  private byId = new Map<number, number>();

  add(interactionId: number, duration: number): void {
    if (!interactionId) return;
    const prev = this.byId.get(interactionId) ?? 0;
    if (duration > prev) this.byId.set(interactionId, duration);
  }

  estimate(): number | null {
    if (!this.byId.size) return null;
    const all = [...this.byId.values()].sort((a, b) => b - a);
    return all[Math.min(all.length - 1, Math.floor(all.length / 50))]!;
  }
}

/* ─────────── переход между экранами ─────────── */

/**
 * «Экран успокоился»: от перехода до последнего изменения разметки, после
 * которого полсекунды тишины. Скелеты загрузки, подгрузка куска экрана и
 * приход данных — всё это изменения; «успокоился» значит «всё приехало».
 * Больше пятнадцати секунд не ждём: такой переход и так «погано», а экран с
 * живой лентой не успокаивается никогда.
 */
export class SettleTracker {
  private lastChange: number;

  constructor(
    private readonly start: number,
    private readonly quietMs = 500,
    private readonly capMs = 15_000,
  ) {
    this.lastChange = start;
  }

  mutate(t: number): void {
    if (t > this.lastChange) this.lastChange = t;
  }

  /** Длительность перехода, если экран уже успокоился (или вышел лимит); иначе null */
  poll(t: number): number | null {
    if (t - this.start >= this.capMs) return this.capMs;
    if (t - this.lastChange >= this.quietMs) return this.lastChange - this.start;
    return null;
  }
}

/**
 * Начало перехода: нажатие, если оно было только что, иначе момент смены
 * адреса. Смену адреса консоль узнаёт уже после того, как React отрисовал
 * новый экран, — отсчёт от неё терял бы время от нажатия до первой
 * отрисовки, то есть ровно то, что человек и ждал.
 */
export function navStart(changedAt: number, lastInputAt: number | null, windowMs = 1000): number {
  return lastInputAt !== null && changedAt - lastInputAt >= 0 && changedAt - lastInputAt < windowMs ? lastInputAt : changedAt;
}
