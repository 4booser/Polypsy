import { describe, expect, test } from "bun:test";
import type {
  OpsCompareStats,
  OpsJob,
  OpsRouteCompare,
  OpsRouteStat,
  OpsStatement,
  OpsTableStat,
  OpsTrafficBucket,
} from "@quizzy/shared";
import {
  ROUTE_P95_MIN,
  binColumns,
  binSeries,
  binStack,
  bucketKnown,
  connectionShares,
  deadRowsAlarm,
  jobsByDuration,
  jobsByFailures,
  latencyLines,
  parseTrafficWindow,
  routes5xx,
  routesByCount,
  routesByP95,
  share5xxLine,
  stepNext,
  stepStart,
  stepTick,
  stepTip,
  tablesByDead,
  tablesBySize,
  topRest,
  trafficStack,
  trafficTip,
  trafficTotals,
} from "../src/pages/ops/model";
import { errorPairs, latencyPairs, statementShares, statementsTop, traceTime } from "../src/pages/ops/obs2a/model";

/**
 * Графики техпанели (волна 11): ряды, которые рисуют pages/ops/charts.tsx и
 * obs2a/charts.tsx. Проверяется то, на чём график соврал бы молча: «не
 * знаем» нарисовано нулём, местные сутки посчитаны по Гринвичу, «інші»
 * потеряли остаток, малая выборка попала в рейтинг.
 *
 * Время — местными датами (new Date(г, м, д, ч)): корзины считаются по
 * часовому поясу того, кто смотрит, и проверка обязана проходить в любом
 * поясе, в котором её запустят.
 */

const bucket = (at: string, requests: number, c4 = 0, c5 = 0, p = 40): OpsTrafficBucket => ({
  at,
  requests,
  errors4xx: c4,
  errors5xx: c5,
  avgMs: requests ? p / 2 : null,
  maxMs: requests ? p * 2 : null,
  p50: requests ? p / 2 : null,
  p95: requests ? p : null,
  p99: requests ? p * 1.5 : null,
});

const utc = (h: number, m = 0) => new Date(Date.UTC(2026, 8, 26, h, m)).toISOString();

describe("нагрузка по корзинам", () => {
  const buckets = [bucket(utc(12, 0), 0), bucket(utc(12, 1), 10, 2, 1), bucket(utc(12, 2), 0), bucket(utc(12, 3), 4, 0, 4, 90)];

  test("до запуска процесса — «не знаем», а не ноль; корзина запуска — своя", () => {
    // процесс поднялся в 12:01:30 — корзина 12:01 уже со счётом, 12:00 — нет
    const since = new Date(Date.UTC(2026, 8, 26, 12, 1, 30)).toISOString();
    const cols = trafficStack(buckets, 60, since, (iso) => iso.slice(11, 16), (iso) => `tip ${iso.slice(11, 16)}`);
    expect(cols[0]!.values).toBeNull();
    expect(cols[1]!.values).toEqual([7, 2, 1]);
    // тихая минута после запуска — честный ноль
    expect(cols[2]!.values).toEqual([0, 0, 0]);
    expect(cols[3]!.values).toEqual([0, 0, 4]);
    expect(cols[1]!.tip).toBe("tip 12:01");
    expect(bucketKnown(utc(12, 0), 60, since)).toBe(false);
    expect(bucketKnown(utc(12, 1), 60, since)).toBe(true);
  });

  test("перцентили и доля 5xx рвутся на пустой корзине", () => {
    expect(latencyLines(buckets).p95).toEqual([null, 40, null, 90]);
    expect(latencyLines(buckets).p99).toEqual([null, 60, null, 135]);
    expect(share5xxLine(buckets)).toEqual([null, 0.1, null, 1]);
  });

  test("итог окна по классам сходится с суммой запросов", () => {
    const t = trafficTotals(buckets);
    expect(t).toEqual({ ok: 7, c4: 2, c5: 5 });
    expect(t.ok + t.c4 + t.c5).toBe(14);
  });

  test("подсказка корзины — начало и конец", () => {
    expect(trafficTip(utc(12, 15), 900, "uk-UA")).toMatch(/–/);
  });

  test("окно «Запитів»: три значения, остальное — час", () => {
    expect(parseTrafficWindow("6h")).toBe("6h");
    expect(parseTrafficWindow("24h")).toBe("24h");
    expect(parseTrafficWindow("7d")).toBe("1h");
    expect(parseTrafficWindow(null)).toBe("1h");
  });
});

describe("корзины по местному календарю", () => {
  test("начало корзины: минута, час, шестичасовка, сутки — по местным часам", () => {
    const at = new Date(2026, 8, 26, 14, 37, 12, 500).getTime();
    expect(stepStart(at, "minute")).toBe(new Date(2026, 8, 26, 14, 37).getTime());
    expect(stepStart(at, "hour")).toBe(new Date(2026, 8, 26, 14).getTime());
    expect(stepStart(at, "6h")).toBe(new Date(2026, 8, 26, 12).getTime());
    expect(stepStart(at, "day")).toBe(new Date(2026, 8, 26).getTime());
  });

  test("следующие сутки — местная полночь, в том числе через перевод часов", () => {
    // последнее воскресенье октября: в Европе сутки длятся 25 часов
    for (let d = new Date(2026, 9, 20).getTime(), i = 0; i < 14; i++) {
      const next = stepNext(d, "day");
      expect(new Date(next).getHours()).toBe(0);
      expect(new Date(next).getDate()).not.toBe(new Date(d).getDate());
      d = next;
    }
    expect(new Date(stepNext(new Date(2026, 8, 26, 18).getTime(), "6h")).getHours()).toBe(0);
  });

  test("разреженные часы сервера — в сплошной ряд местных суток, пустые — нулём", () => {
    const from = new Date(2026, 8, 20, 10).getTime();
    const to = new Date(2026, 8, 26, 9).getTime();
    const points = [
      // два часа одних местных суток — одна корзина
      { at: new Date(2026, 8, 21, 1).toISOString(), count: 2 },
      { at: new Date(2026, 8, 21, 23).toISOString(), count: 3 },
      { at: new Date(2026, 8, 26, 8).toISOString(), count: 1 },
      // вне ряда — не теряется молча в соседнюю корзину, а не входит
      { at: new Date(2026, 8, 27, 1).toISOString(), count: 100 },
    ];
    const bins = binSeries(points, ["count"], from, to, "day");
    expect(bins.length).toBe(7);
    expect(bins[0]!.start).toBe(new Date(2026, 8, 20).getTime());
    expect(bins.map((b) => b.values.count)).toEqual([0, 5, 0, 0, 0, 0, 1]);
  });

  test("несколько рядов сразу; столбцы и столбцы с разбивкой — из одних корзин", () => {
    const from = new Date(2026, 8, 26, 10).getTime();
    const to = new Date(2026, 8, 26, 12, 30).getTime();
    const points = [
      { at: new Date(2026, 8, 26, 10).toISOString(), debug: 0, info: 50, warn: 2, error: 1 },
      { at: new Date(2026, 8, 26, 12).toISOString(), debug: 0, info: 20, warn: 0, error: 3 },
    ];
    const bins = binSeries(points, ["info", "warn", "error"], from, to, "hour");
    expect(bins.length).toBe(3);
    const cols = binColumns(bins, "info", "hour", "uk-UA");
    expect(cols.map((c) => c.value)).toEqual([50, 0, 20]);
    expect(cols[0]!.tip).toMatch(/–/);
    const stack = binStack(bins, ["warn", "error"], "hour", "uk-UA");
    expect(stack.map((c) => c.values)).toEqual([
      [2, 1],
      [0, 0],
      [0, 3],
    ]);
  });

  test("подписи: время для минут и часов, дата для шестичасовок и суток", () => {
    const at = new Date(2026, 8, 26, 12).getTime();
    expect(stepTick(at, "hour", "uk-UA")).toMatch(/12/);
    expect(stepTick(at, "day", "uk-UA")).toMatch(/26/);
    expect(stepTip(at, "6h", "uk-UA")).toMatch(/12.00–18.00/);
    expect(stepTip(new Date(2026, 8, 26, 18).getTime(), "6h", "uk-UA")).toMatch(/18.00–00.00/);
  });
});

const route = (over: Partial<OpsRouteStat>): OpsRouteStat => ({
  method: "GET",
  route: "/api/x",
  requests: 0,
  errors4xx: 0,
  errors5xx: 0,
  share5xx: null,
  avgMs: null,
  p50: null,
  p95: null,
  p99: null,
  maxMs: null,
  ...over,
});

describe("рейтинги", () => {
  test("первые N и «інші» с остатком: сумма рейтинга равна сумме всего", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ v: i + 1 }));
    const r = topRest(items, 8, (x) => x.v);
    expect(r.top.map((x) => x.v)).toEqual([12, 11, 10, 9, 8, 7, 6, 5]);
    expect(r.rest).toBe(4);
    expect(r.restSum).toBe(1 + 2 + 3 + 4);
    expect(r.top.reduce((s, x) => s + x.v, 0) + r.restSum).toBe(78);
    expect(topRest(items, 20, (x) => x.v).rest).toBe(0);
  });

  test("по числу запросов — все маршруты; по p95 — только от порога выборки", () => {
    const items = [
      route({ route: "/a", requests: 500, p95: 40 }),
      route({ route: "/b", requests: ROUTE_P95_MIN - 1, p95: 9000 }),
      route({ route: "/c", requests: ROUTE_P95_MIN, p95: 300 }),
      route({ route: "/d", requests: 100, p95: null }),
    ];
    expect(routesByCount(items).top.map((r) => r.route)).toEqual(["/a", "/d", "/c", "/b"]);
    const p95 = routesByP95(items);
    // одиночный медленный запрос на редком маршруте рейтинг не возглавляет
    expect(p95.top.map((r) => r.route)).toEqual(["/c", "/a"]);
    expect(p95.few).toBe(2);
  });

  test("пятисотки — по доле, при равенстве — по числу; маршруты без них не рисуются", () => {
    const items = [
      route({ route: "/a", requests: 1000, errors5xx: 10 }),
      route({ route: "/b", requests: 1, errors5xx: 1 }),
      route({ route: "/c", requests: 4, errors5xx: 4 }),
      route({ route: "/d", requests: 50, errors5xx: 0 }),
    ];
    expect(routes5xx(items).top.map((r) => r.route)).toEqual(["/c", "/b", "/a"]);
  });
});

const job = (over: Partial<OpsJob>): OpsJob => ({
  name: "j",
  intervalSec: 60,
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
  manual: false,
  lastByHand: false,
  ...over,
});

describe("задачи и база", () => {
  test("сбои — только у тех, у кого были; длительность — только у ходивших", () => {
    const items = [job({ name: "a", runs: 5, failures: 0, lastDurationMs: 12 }), job({ name: "b", runs: 3, failures: 2, lastDurationMs: 800 }), job({ name: "c" })];
    expect(jobsByFailures(items).map((j) => j.name)).toEqual(["b"]);
    expect(jobsByDuration(items).top.map((j) => j.name)).toEqual(["b", "a"]);
  });

  const table = (over: Partial<OpsTableStat>): OpsTableStat => ({
    table: "t",
    totalBytes: 0,
    tableBytes: 0,
    indexBytes: 0,
    liveRows: 0,
    deadRows: 0,
    seqScan: null,
    idxScan: null,
    lastAutovacuum: null,
    lastAutoanalyze: null,
    ...over,
  });

  test("десять самых больших и «інші» — остаток присланных", () => {
    const tables = Array.from({ length: 25 }, (_, i) => table({ table: `t${i}`, totalBytes: (25 - i) * 1024 }));
    const r = tablesBySize(tables);
    expect(r.top.length).toBe(10);
    expect(r.rest).toBe(15);
    expect(r.restSum).toBe(Array.from({ length: 15 }, (_, i) => (15 - i) * 1024).reduce((s, v) => s + v, 0));
  });

  test("мёртвые строки: внимание — больше тысячи и больше пятой части живых", () => {
    expect(deadRowsAlarm({ deadRows: 5000, liveRows: 10_000 })).toBe(true);
    expect(deadRowsAlarm({ deadRows: 900, liveRows: 100 })).toBe(false);
    expect(deadRowsAlarm({ deadRows: 5000, liveRows: 100_000 })).toBe(false);
    expect(deadRowsAlarm({ deadRows: null, liveRows: 10 })).toBe(false);
    const dead = tablesByDead([table({ table: "a", deadRows: 3 }), table({ table: "b", deadRows: 0 }), table({ table: "c", deadRows: 70 })]);
    expect(dead.top.map((t) => t.table)).toEqual(["c", "a"]);
  });

  test("подключения: свободные до max_connections — последней частью, без max — не выдумываются", () => {
    const byState = [
      { state: "active" as const, count: 3 },
      { state: "idle" as const, count: 7 },
    ];
    expect(connectionShares({ total: 10, max: 100, byState })).toEqual([...byState, { state: "free", count: 90 }]);
    expect(connectionShares({ total: 10, max: null, byState })).toEqual(byState);
  });
});

const stats = (over: Partial<OpsCompareStats>): OpsCompareStats => ({ requests: 100, errors5xx: 0, share5xx: 0, p50: 10, p95: 50, ...over });
const cmp = (route: string, before: OpsCompareStats | null, after: OpsCompareStats | null, over: Partial<OpsRouteCompare> = {}): OpsRouteCompare => ({
  method: "GET",
  route,
  before,
  after,
  latency: "same",
  errors: "same",
  ...over,
});

describe("сравнение выкаток, SQL, трасса", () => {
  test("пары p95: по величине сдвига в любую сторону, без «замало» и без половинок", () => {
    const items = [
      cmp("/small", stats({ p95: 50 }), stats({ p95: 60 })),
      cmp("/faster", stats({ p95: 900 }), stats({ p95: 300 }), { latency: "better" }),
      cmp("/slower", stats({ p95: 100 }), stats({ p95: 500 }), { latency: "worse" }),
      cmp("/few", stats({ p95: 10 }), stats({ p95: 5000 }), { latency: "few" }),
      cmp("/new", null, stats({ p95: 80 })),
    ];
    expect(latencyPairs(items).map((r) => r.route)).toEqual(["/faster", "/slower", "/small"]);
  });

  test("пары 5xx: только где пятисотки были хоть в одном окне", () => {
    const items = [
      cmp("/clean", stats({}), stats({})),
      cmp("/broke", stats({}), stats({ errors5xx: 20, share5xx: 0.2 }), { errors: "worse" }),
      cmp("/fixed", stats({ errors5xx: 5, share5xx: 0.05 }), stats({})),
    ];
    expect(errorPairs(items).map((r) => r.route)).toEqual(["/broke", "/fixed"]);
  });

  const st = (id: string, share: number | null, totalMs = 10, calls = 1): OpsStatement => ({
    id,
    calls,
    totalMs,
    meanMs: totalMs / calls,
    rows: 0,
    share,
    query: `select ${id}`,
  });

  test("доля времени базы: первые пять и «решта» от единицы, а не от списка", () => {
    const items = [st("a", 0.4), st("b", 0.2), st("c", 0.1), st("d", 0.05), st("e", 0.05), st("f", 0.05)];
    const s = statementShares(items)!;
    expect(s.top.map((x) => x.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(s.rest).toBeCloseTo(0.2, 6);
    expect(statementShares([st("a", null)])).toBeNull();
  });

  test("первые по выбранному порядку", () => {
    const items = [st("a", null, 100, 1), st("b", null, 10, 50), st("c", null, 50, 5)];
    expect(statementsTop(items, "calls").top.map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(statementsTop(items, "total", 2)).toMatchObject({ rest: 1 });
  });

  test("время запроса: SQL не больше итога, без замера — полосы нет", () => {
    const s = { at: utc(12), method: "GET", route: "/x", status: 200, ms: 100, role: null, sqlCount: 3, sqlMs: 30 };
    expect(traceTime(s)).toEqual({ sql: 30, other: 70 });
    expect(traceTime({ ...s, sqlMs: 120 })).toEqual({ sql: 100, other: 0 });
    expect(traceTime({ ...s, sqlMs: null })).toBeNull();
    expect(traceTime(null)).toBeNull();
  });
});
