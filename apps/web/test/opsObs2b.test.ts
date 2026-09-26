import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  VITAL_METRICS,
  uiText,
  type OpsAlertRule,
  type OpsAlertState,
  type OpsClientErrorGroup,
  type OpsJob,
  type OpsRecordings,
  type OpsVitalCell,
} from "@quizzy/shared";
import { JOB_KEY } from "../src/pages/ops/model";
import {
  EVENT_TONE,
  RATING_TONE,
  STATE_TONE,
  canRunNow,
  diskMismatch,
  draftOf,
  filterClientErrors,
  fmtRuleValue,
  fmtVital,
  freeShare,
  parseKind,
  parseMetric,
  parseNum,
  parsePlatform,
  ruleInputOf,
  sparkOf,
  toggleChannel,
  unavailableKey,
  vitalSeries,
} from "../src/pages/ops/obs2b/model";
import {
  ClsAccumulator,
  InpAccumulator,
  SettleTracker,
  errorInput,
  isReportableFailure,
  navStart,
  networkInput,
  sampleDecision,
} from "../src/telemetry/model";

/**
 * Техпанель, участок obs2b: чистая логика разделов (pages/ops/obs2b/model.ts),
 * телеметрия консоли (telemetry/model.ts) и сторож оформления новых экранов.
 * Серверная половина — apps/api/test/opsObs2b.test.ts.
 */

const rule = (over: Partial<OpsAlertRule> = {}): OpsAlertRule => ({
  key: "errors5xx",
  enabled: true,
  threshold: 5,
  windowMin: 10,
  repeatMin: 60,
  channels: ["telegram", "email"],
  state: "ok",
  unavailable: null,
  firingSince: null,
  lastValue: 1.2,
  lastCheckedAt: null,
  lastSentAt: null,
  updatedAt: null,
  ...over,
});

describe("сповіщення: правка правила", () => {
  test("черновик из правила и обратно — те же числа", () => {
    const d = draftOf(rule());
    expect(d).toEqual({ enabled: true, threshold: "5", windowMin: "10", repeatMin: "60", channels: ["telegram", "email"] });
    expect(ruleInputOf("errors5xx", d)).toEqual({
      input: { enabled: true, threshold: 5, windowMin: 10, repeatMin: 60, channels: ["telegram", "email"] },
    });
  });

  test("запятая — десятичный знак; вне пределов сервера — ошибка у поля, а не 400 после", () => {
    expect(parseNum(" 7,5 ")).toBe(7.5);
    expect(parseNum("")).toBeNull();
    expect(parseNum("abc")).toBeNull();
    const d = draftOf(rule());
    expect(ruleInputOf("errors5xx", { ...d, threshold: "0" })).toEqual({ error: "threshold" });
    expect(ruleInputOf("errors5xx", { ...d, windowMin: "2,5" })).toEqual({ error: "window" });
    expect(ruleInputOf("errors5xx", { ...d, repeatMin: "1" })).toEqual({ error: "repeat" });
    expect(ruleInputOf("p95", { ...d, threshold: "2400" })).toMatchObject({ input: { threshold: 2400 } });
  });

  test("у правил без окна окно не шлётся; у проверки журнала — и порог", () => {
    const disk = ruleInputOf("diskFree", { enabled: true, threshold: "12", windowMin: "99", repeatMin: "360", channels: [] });
    expect(disk).toEqual({ input: { enabled: true, threshold: 12, repeatMin: 360, channels: [] } });
    const chain = ruleInputOf("auditChain", { enabled: false, threshold: "", windowMin: "", repeatMin: "1440", channels: ["email"] });
    expect(chain).toEqual({ input: { enabled: false, repeatMin: 1440, channels: ["email"] } });
  });

  test("каналы — переключателями, по одному", () => {
    expect(toggleChannel(["telegram"], "email")).toEqual(["telegram", "email"]);
    expect(toggleChannel(["telegram", "email"], "telegram")).toEqual(["email"]);
  });

  test("значение в единице правила; у проверки журнала числа нет", () => {
    expect(fmtRuleValue("errors5xx", 7.25, "uk")).toBe("7,3%");
    expect(fmtRuleValue("p95", 2400, "en")).toBe("2,400 ms");
    expect(fmtRuleValue("schedulerSilent", 135, "en")).toBe("135 min");
    expect(fmtRuleValue("auditChain", 0, "uk")).toBe("—");
    expect(fmtRuleValue("diskFree", null, "uk")).toBe("—");
  });

  test("сбой — ромбом и янтарём; «недоступно» — не «гаразд»", () => {
    const states: OpsAlertState[] = ["ok", "firing", "unavailable", "off", "unknown"];
    expect(states.map((s) => STATE_TONE[s])).toEqual(["ok", "fail", "quiet", "quiet", "quiet"]);
    expect(EVENT_TONE.resolved).toBe("ok");
    expect(unavailableKey("noSource")).toBe("o2b.unavail.noSource");
    // незнакомый код (сервер новее консоли) — без пояснения, а не чужое пояснение
    expect(unavailableKey("fromTheFuture")).toBeNull();
  });
});

describe("помилки клієнта: фильтры", () => {
  const g = (over: Partial<OpsClientErrorGroup>): OpsClientErrorGroup => ({
    fingerprint: "f",
    platform: "web",
    kind: "react",
    name: "TypeError",
    message: "x is undefined",
    route: "/patients/:id",
    apiMethod: null,
    apiRoute: null,
    status: null,
    release: "abc123",
    browser: "Chrome 128",
    os: "Windows",
    count: 1,
    firstAt: "2026-09-26T10:00:00.000Z",
    lastAt: "2026-09-26T11:00:00.000Z",
    frames: [],
    ...over,
  });

  test("платформа, вид и поиск вместе", () => {
    const items = [
      g({ fingerprint: "a" }),
      g({ fingerprint: "b", platform: "mobile", kind: "error", route: "/survey/:id" }),
      g({ fingerprint: "c", kind: "network", apiRoute: "/api/today", status: 502 }),
    ];
    expect(filterClientErrors(items, { q: "", platform: "all", kind: "all" }).map((x) => x.fingerprint)).toEqual(["a", "b", "c"]);
    expect(filterClientErrors(items, { q: "", platform: "mobile", kind: "all" }).map((x) => x.fingerprint)).toEqual(["b"]);
    expect(filterClientErrors(items, { q: "/API/TODAY", platform: "all", kind: "network" }).map((x) => x.fingerprint)).toEqual(["c"]);
    expect(parsePlatform("desktop")).toBe("all");
    expect(parseKind("network")).toBe("network");
    expect(parseKind("oops")).toBe("all");
  });
});

describe("швидкість екранів", () => {
  const cell: OpsVitalCell = { p75: 1800, n: 40, rating: "good", daily: [null, 1600, null, 2100] };

  test("ход — только дни с замерами; пустой день — не ноль", () => {
    const pts = vitalSeries(cell, ["2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"], (d) => d.slice(5));
    expect(pts).toEqual([
      { x: "09-24", y: 1600 },
      { x: "09-26", y: 2100 },
    ]);
    expect(sparkOf(cell)).toEqual([1600, 2100]);
    expect(vitalSeries(undefined, [], String)).toEqual([]);
  });

  test("значения мер: CLS без единицы, секунды от тысячи, оценка словом и формой", () => {
    expect(fmtVital("CLS", 0.021, "uk")).toBe("0,021");
    expect(fmtVital("LCP", 2500, "en")).toBe("2.5 sec");
    expect(fmtVital("INP", 180, "en")).toBe("180 ms");
    expect(fmtVital("TTFB", null, "en")).toBe("—");
    expect(RATING_TONE).toEqual({ good: "ok", needs: "warn", poor: "fail" });
    expect(parseMetric("NAV")).toBe("NAV");
    expect(parseMetric("FID")).toBe("LCP");
  });
});

describe("записи прийомів", () => {
  const rec = (over: Partial<OpsRecordings> = {}): OpsRecordings => ({
    byStatus: [
      { status: "done", count: 10, bytes: 1000 },
      { status: "failed", count: 2, bytes: 50 },
    ],
    stored: { count: 12, bytes: 1050 },
    disk: { files: 14, bytes: 1100, truncated: false, totalBytes: 1000, freeBytes: 80 },
    queue: { waiting: 1, transcribing: 0, oldestWaitingSec: 60, stuck: 0 },
    failed: [],
    transcriberHere: false,
    ...over,
  });

  test("сверка диска с базой: сироты и недостача; не сверить — null", () => {
    expect(diskMismatch(rec())).toEqual({ orphans: 2, missing: 0 });
    expect(diskMismatch(rec({ disk: { files: 10, bytes: 1, truncated: false, totalBytes: null, freeBytes: null } }))).toEqual({
      orphans: 0,
      missing: 2,
    });
    expect(diskMismatch(rec({ disk: null }))).toBeNull();
    expect(diskMismatch(rec({ disk: { files: 20_000, bytes: 1, truncated: true, totalBytes: 1, freeBytes: 1 } }))).toBeNull();
    expect(freeShare(rec())).toBe(0.08);
    expect(freeShare(rec({ disk: null }))).toBeNull();
  });
});

describe("фонові задачі: «Запустити зараз»", () => {
  const job = (over: Partial<OpsJob>): OpsJob => ({
    name: "analytics.cache",
    intervalSec: 0,
    runs: 0,
    failures: 0,
    skipped: 0,
    lastStartAt: null,
    lastEndAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
    lastErrorAt: null,
    nextAt: null,
    manual: true,
    lastByHand: false,
    ...over,
  });

  test("только ручные и только когда не идут", () => {
    expect(canRunNow(job({}))).toBe(true);
    expect(canRunNow(job({ lastResult: "running" }))).toBe(false);
    expect(canRunNow(job({ manual: false }))).toBe(false);
  });

  test("у каждой ручной задачи есть имя по-человечески на трёх языках", () => {
    for (const name of ["analytics.cache", "search.reindex", "catalog.install", "retention", "ops.alerts"]) {
      const key = JOB_KEY[name]!;
      expect(key, name).toBeDefined();
      for (const lang of ["uk", "ru", "en"] as const) expect(uiText(key, lang), `${name} ${lang}`).not.toBe(key);
    }
  });
});

describe("телеметрия консоли", () => {
  const ctx = { route: "/patients/7c9e6679-7425-40de-944b-e07fc1f90ae7/case", release: "abc123", ua: "Mozilla/5.0 (Windows NT 10.0) Chrome/128.0.1 Safari/537.36" };

  test("выборка решается раз на сессию и помнится", () => {
    expect(sampleDecision(null, 0.1)).toEqual({ on: true, store: "1" });
    expect(sampleDecision(null, 0.5)).toEqual({ on: false, store: "0" });
    expect(sampleDecision("1", 0.99)).toEqual({ on: true, store: null });
    expect(sampleDecision("0", 0.01)).toEqual({ on: false, store: null });
  });

  test("ошибка — шаблон адреса, текст без почты, браузер грубо", () => {
    const e = new TypeError("no user ivan@example.com");
    const out = errorInput(e, "error", ctx)!;
    expect(out).toMatchObject({
      platform: "web",
      kind: "error",
      name: "TypeError",
      message: "no user [email]",
      route: "/patients/:id/case",
      release: "abc123",
      browser: "Chrome 128",
      os: "Windows",
    });
    expect(JSON.stringify(out)).not.toContain("7c9e6679");
  });

  test("отказ API — не падение экрана; шум браузера — не наша ошибка", () => {
    const apiError = Object.assign(new Error("Недостатньо прав"), { status: 403 });
    expect(errorInput(apiError, "rejection", ctx)).toBeNull();
    expect(errorInput(new Error("ResizeObserver loop completed with undelivered notifications."), "error", ctx)).toBeNull();
    expect(errorInput("plain string", "rejection", ctx)).toMatchObject({ name: "Error", message: "plain string" });
  });

  test("сетевой сбой: 5xx — всегда, «не дошли» — только в сети; 4xx — никогда", () => {
    expect(isReportableFailure(502, true)).toBe(true);
    expect(isReportableFailure(0, true)).toBe(true);
    expect(isReportableFailure(0, false)).toBe(false);
    expect(isReportableFailure(404, true)).toBe(false);
    const id = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
    expect(networkInput({ method: "get", path: `/api/patients/${id}?q=Іван`, status: 503 }, true, ctx)).toMatchObject({
      kind: "network",
      name: "HTTP 503",
      apiMethod: "GET",
      apiRoute: "/api/patients/:id",
      status: 503,
      route: "/patients/:id/case",
    });
    // сама телеметрия о себе не сообщает
    expect(networkInput({ method: "POST", path: "/api/ops/client-errors", status: 500 }, true, ctx)).toBeNull();
  });

  test("CLS — самое тяжёлое окно сдвигов; сдвиг после ввода не считается", () => {
    const c = new ClsAccumulator();
    expect(c.value).toBeNull();
    c.add(0.05, 0, false);
    c.add(0.05, 500, false); // то же окно: 0,10
    c.add(0.3, 900, true); // после ввода — мимо
    c.add(0.02, 3000, false); // новое окно
    expect(c.value).toBeCloseTo(0.1);
    // окно не длиннее пяти секунд, даже если сдвиги идут чаще секунды
    const long = new ClsAccumulator();
    for (let t = 0; t <= 6000; t += 500) long.add(0.01, t, false);
    expect(long.value!).toBeLessThan(0.12);
  });

  test("INP — худшее взаимодействие, при частых — почти худшее", () => {
    const i = new InpAccumulator();
    expect(i.estimate()).toBeNull();
    i.add(1, 40);
    i.add(1, 120); // то же взаимодействие: берётся долгое событие
    i.add(2, 80);
    i.add(0, 900); // без номера взаимодействия — не взаимодействие
    expect(i.estimate()).toBe(120);
    const many = new InpAccumulator();
    for (let k = 1; k <= 100; k++) many.add(k, k === 100 ? 5000 : k === 99 ? 3000 : 50);
    // на сотне взаимодействий отбрасываются два худших из-за случайности: берётся третье
    expect(many.estimate()).toBe(50);
  });

  test("переход: до последнего изменения, после которого полсекунды тишины; не дольше 15 с", () => {
    const s = new SettleTracker(1000);
    s.mutate(1200);
    s.mutate(1900);
    expect(s.poll(2100)).toBeNull();
    expect(s.poll(2400)).toBe(900);
    const busy = new SettleTracker(0);
    for (let t = 0; t < 20_000; t += 200) busy.mutate(t);
    expect(busy.poll(15_000)).toBe(15_000);
    // начало — нажатие, если оно было только что
    expect(navStart(5000, 4700)).toBe(4700);
    expect(navStart(5000, 3000)).toBe(5000);
    expect(navStart(5000, null)).toBe(5000);
  });
});

/**
 * Сторож оформления: новые разделы написаны в языке Polypsy, наследию в них
 * взяться неоткуда — кроме копирования со старого экрана. То же правило,
 * что у вкладок участка ops (apps/web/test/ops.test.ts).
 */
describe("разделы obs2b без наследия", () => {
  const FILES = [
    ...["Alerts", "ClientErrors", "Vitals", "Recordings", "parts"].map((n) => resolve(import.meta.dir, `../src/pages/ops/obs2b/${n}.tsx`)),
    resolve(import.meta.dir, "../src/telemetry/ErrorBoundary.tsx"),
  ];
  const LEGACY = new Set(["card", "tile", "row", "chip", "btn", "hint", "muted", "tabs", "grid-cols-2", "cols-2", "cols-3", "cols-4"]);

  test("нет классов наследия", () => {
    const found: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g)) {
        for (const token of m[1]!.split(/\s+/)) if (LEGACY.has(token)) found.push(`${file}: ${token}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("ни одного инлайнового стиля и ни одного хекса", () => {
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      expect(src.includes("style={{"), file).toBe(false);
      expect(/#[0-9a-fA-F]{3,6}\b/.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), file).toBe(false);
    }
  });

  test("у каждой меры есть подпись и пояснение на трёх языках", () => {
    for (const m of VITAL_METRICS) {
      for (const lang of ["uk", "ru", "en"] as const) {
        expect(uiText(`o2b.metric.${m}` as never, lang)).not.toBe(`o2b.metric.${m}`);
        expect(uiText(`o2b.metric.${m}.what` as never, lang)).not.toBe(`o2b.metric.${m}.what`);
      }
    }
  });
});
