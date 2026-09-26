import { useLayoutEffect } from "react";
import {
  TelemetryBuffer,
  clientErrorKey,
  routeTemplate,
  type ClientErrorInput,
  type ClientErrorKind,
  type VitalInput,
  type VitalMetric,
} from "@quizzy/shared";
import { tokenStore } from "../api";
import { onNetworkFailure } from "./bus";
import {
  ClsAccumulator,
  InpAccumulator,
  SettleTracker,
  errorInput,
  navStart,
  networkInput,
  sampleDecision,
  type ErrorContext,
} from "./model";

/**
 * Телеметрия консоли и кабинета: ошибки клиента и скорость экранов.
 *
 * Решение заказчика 2026-09-26 (техпанель, участок obs2b): падения React,
 * window.onerror / unhandledrejection, сетевые сбои (сеть, 5xx) — в раздел
 * «Помилки клієнта»; LCP, INP, CLS, TTFB и время перехода между экранами —
 * в «Швидкість екранів». Всё — пачками, с потолками, без ПДн: адрес —
 * шаблоном маршрута, текст — вычищен (model.ts, @quizzy/shared), браузер и
 * ОС — грубо. Новых зависимостей нет: PerformanceObserver умеет всё нужное
 * сам, а библиотека web-vitals — ещё один чужой код в консоли медицинской
 * системы ради трёхсот строк.
 *
 * Ничто здесь не вправе уронить консоль: каждое действие обёрнуто, отказ
 * отправки глотается, а экран, падающий в цикле, упирается в потолок
 * сессии, а не заваливает сервер.
 */

const RELEASE: string | undefined = typeof __BUILD_SHA__ === "string" && /^[\w.+:-]{1,64}$/.test(__BUILD_SHA__) ? __BUILD_SHA__ : undefined;

/* ─────────── отправка ─────────── */

const errors = new TelemetryBuffer<ClientErrorInput>({
  maxBatch: 20,
  maxBuffered: 50,
  sessionCap: 100,
  keyOf: clientErrorKey,
  merge: (kept, next) => ({ ...kept, count: (kept.count ?? 1) + (next.count ?? 1) }),
});

const vitals = new TelemetryBuffer<VitalInput>({ maxBatch: 50, maxBuffered: 200, sessionCap: 600 });

/** Сервер ответил «слишком часто» — молчим до этого момента */
let pausedUntil = 0;
/** Отправка ошибок уже назначена — второй таймер не заводим */
let errorsScheduled = false;

async function post(path: string, items: unknown[], keepalive: boolean): Promise<void> {
  const token = tokenStore.get();
  try {
    const res = await fetch(path, {
      method: "POST",
      keepalive,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ items }),
    });
    if (res.status === 429) pausedUntil = Date.now() + Number(res.headers.get("Retry-After") ?? 60) * 1000;
  } catch {
    /* нет сети — пачка потеряна; ошибка о потере ошибки никому не нужна */
  }
}

function scheduleErrors(ms: number): void {
  if (errorsScheduled) return;
  errorsScheduled = true;
  setTimeout(() => flushErrors(), ms);
}

function flushErrors(keepalive = false): void {
  errorsScheduled = false;
  if (!errors.size || Date.now() < pausedUntil) return;
  /* без входа сервер берёт не больше пяти за раз — столько и шлём */
  const batch = errors.take(tokenStore.get() ? 20 : 5);
  void post("/api/ops/client-errors", batch, keepalive);
  if (errors.size) scheduleErrors(10_000);
}

function flushVitals(keepalive = false): void {
  if (!vitals.size || Date.now() < pausedUntil) return;
  const batch = vitals.take();
  /* скорость экранов принимается только от вошедших; до входа — не копим */
  if (!tokenStore.get()) return;
  void post("/api/ops/vitals", batch, keepalive);
}

function queueError(item: ClientErrorInput | null): void {
  if (!item) return;
  errors.add(item);
  scheduleErrors(3000);
}

function pushVital(metric: VitalMetric, route: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) return;
  vitals.add({ metric, route, value: metric === "CLS" ? Math.round(value * 10_000) / 10_000 : Math.round(value) });
}

const ctx = (): ErrorContext => ({ route: location.pathname, release: RELEASE, ua: navigator.userAgent });

/** Падение экрана, пойманное границей ошибок (ErrorBoundary.tsx) */
export function reportReactError(error: unknown, componentStack?: string | null): void {
  try {
    queueError(errorInput(error, "react", ctx(), componentStack ?? undefined));
  } catch {
    /* см. шапку: телеметрия не роняет консоль */
  }
}

function reportGlobal(error: unknown, kind: ClientErrorKind): void {
  try {
    queueError(errorInput(error, kind, ctx()));
  } catch {
    /* то же */
  }
}

/* ─────────── скорость экранов ─────────── */

let measuring = false;
let segment: { route: string; cls: ClsAccumulator; inp: InpAccumulator } | null = null;
let lcp: { route: string; value: number | null; done: boolean } | null = null;
let lastInputAt: number | null = null;
let settle: { tracker: SettleTracker; route: string; observer: MutationObserver; timer: ReturnType<typeof setInterval> } | null = null;

function endSegment(): void {
  if (!segment) return;
  pushVital("CLS", segment.route, segment.cls.value ?? 0);
  const inp = segment.inp.estimate();
  if (inp !== null) pushVital("INP", segment.route, inp);
  segment = null;
}

function finishLcp(): void {
  if (!lcp || lcp.done) return;
  lcp.done = true;
  if (lcp.value !== null) pushVital("LCP", lcp.route, lcp.value);
}

function stopSettle(): void {
  if (!settle) return;
  settle.observer.disconnect();
  clearInterval(settle.timer);
  settle = null;
}

function startSettle(route: string, start: number): void {
  stopSettle();
  const tracker = new SettleTracker(start);
  const observer = new MutationObserver(() => tracker.mutate(performance.now()));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  const timer = setInterval(() => {
    const took = tracker.poll(performance.now());
    if (took === null) return;
    pushVital("NAV", route, took);
    stopSettle();
  }, 100);
  settle = { tracker, route, observer, timer };
}

function observe(type: string, cb: (entries: PerformanceEntry[]) => void, extra: Record<string, unknown> = {}): void {
  try {
    const po = new PerformanceObserver((list) => cb(list.getEntries()));
    po.observe({ type, buffered: true, ...extra } as PerformanceObserverInit);
  } catch {
    /* браузер не знает такой вид записей — эта мера просто не меряется */
  }
}

function startVitals(initialPath: string): void {
  const route = routeTemplate(initialPath);
  segment = { route, cls: new ClsAccumulator(), inp: new InpAccumulator() };
  lcp = { route, value: null, done: false };

  const nav = performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (nav && nav.responseStart > 0) pushVital("TTFB", route, nav.responseStart);

  observe("largest-contentful-paint", (entries) => {
    const last = entries.at(-1);
    if (lcp && !lcp.done && last) lcp.value = last.startTime;
  });
  observe("layout-shift", (entries) => {
    for (const e of entries as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
      segment?.cls.add(e.value, e.startTime, e.hadRecentInput);
    }
  });
  const onEvent = (entries: PerformanceEntry[]) => {
    for (const e of entries as (PerformanceEntry & { interactionId?: number })[]) {
      segment?.inp.add(e.interactionId ?? 0, e.duration);
    }
  };
  observe("event", onEvent, { durationThreshold: 40 });
  observe("first-input", onEvent);

  /*
   * LCP заканчивается на первом вводе: дальше «самое большое» меняется уже
   * от действий человека, а не от загрузки. Ввод же — начало отсчёта
   * перехода (navStart).
   */
  const onInput = () => {
    lastInputAt = performance.now();
    finishLcp();
  };
  addEventListener("pointerdown", onInput, { capture: true, passive: true });
  addEventListener("keydown", onInput, { capture: true, passive: true });
}

let lastPath: string | null = null;

/**
 * Смена адреса в консоли — из App.tsx (useTelemetryRoute).
 *
 * Первый показ — это загрузка страницы, её меряют LCP и TTFB; переходом
 * считается каждая следующая смена пути. Другой человек на том же шаблоне
 * (`/patients/:id` → `/patients/:id`) — тоже переход: экран грузится заново.
 * Смена одного запроса (?tab=) — нет: это тот же экран.
 */
export function routeChanged(pathname: string): void {
  if (!measuring) return;
  try {
    if (lastPath === null || pathname === lastPath) {
      lastPath = pathname;
      return;
    }
    lastPath = pathname;
    finishLcp();
    endSegment();
    const route = routeTemplate(pathname);
    segment = { route, cls: new ClsAccumulator(), inp: new InpAccumulator() };
    startSettle(route, navStart(performance.now(), lastInputAt));
  } catch {
    /* см. шапку */
  }
}

export function useTelemetryRoute(pathname: string): void {
  useLayoutEffect(() => routeChanged(pathname), [pathname]);
}

/* ─────────── заведение ─────────── */

let installed = false;

/**
 * Завести телеметрию: глобальные обработчики, провод от сетевого клиента,
 * замеры скорости (если сессия в выборке). Зовётся один раз из main.tsx.
 */
export function installTelemetry(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    window.addEventListener("error", (e) => {
      /* ошибки загрузки ресурсов сюда не всплывают; здесь — только исключения скриптов */
      reportGlobal(e.error ?? e.message, "error");
    });
    window.addEventListener("unhandledrejection", (e) => reportGlobal(e.reason, "rejection"));
    onNetworkFailure((f) => queueError(networkInput(f, navigator.onLine, ctx())));

    let decision: { on: boolean; store: string | null };
    try {
      decision = sampleDecision(sessionStorage.getItem("quizzy.rum"), Math.random());
      if (decision.store) sessionStorage.setItem("quizzy.rum", decision.store);
    } catch {
      decision = { on: false, store: null };
    }
    measuring = decision.on && typeof PerformanceObserver !== "undefined";
    if (measuring) {
      startVitals(location.pathname);
      setInterval(() => flushVitals(), 20_000);
    }

    /*
     * Уход со страницы — последняя возможность отправить: keepalive
     * дотягивает запрос после закрытия вкладки. Замеры экрана, на котором
     * человек сидел, закрываются здесь же.
     */
    addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") return;
      if (measuring) {
        finishLcp();
        const route = segment?.route;
        endSegment();
        if (route) segment = { route, cls: new ClsAccumulator(), inp: new InpAccumulator() };
        flushVitals(true);
      }
      flushErrors(true);
    });
  } catch {
    /* см. шапку */
  }
}
