import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OpsHealthCheck, OpsLogLine, OpsRouteStat, OpsTrafficBucket } from "@quizzy/shared";
import {
  CONN_KEY,
  HEALTH_NAME,
  bytesUnit,
  fieldsText,
  filterErrors,
  filterRoutes,
  fmtAgo,
  fmtBytes,
  fmtMs,
  fmtShare,
  fmtUptime,
  healthReason,
  latencySeries,
  mergeFeed,
  parseLevel,
  parseSort,
  parseWindow,
  shortId,
  sortMetric,
  sortRoutes,
  trafficColumns,
} from "../src/pages/ops/model";

/**
 * Техпанель: чистая логика вкладок (pages/ops/model.ts) и сторож оформления.
 *
 * Серверная половина — apps/api/test/ops.test.ts. Здесь — то, что экран
 * делает с ответом: порядок маршрутов, слияние живой ленты, ряды графиков,
 * пояснения к проверкам и числа в человеческом виде.
 */

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

const line = (seq: number): OpsLogLine => ({
  seq,
  at: new Date(Date.UTC(2026, 8, 26, 12, 0, seq)).toISOString(),
  level: "info",
  message: `m${seq}`,
  requestId: null,
  fields: {},
});

describe("адрес", () => {
  test("неизвестное значение — умолчание, а не пустой экран", () => {
    expect(parseLevel("warn")).toBe("warn");
    expect(parseLevel("loud")).toBeNull();
    expect(parseLevel(null)).toBeNull();
    expect(parseWindow("24h")).toBe("24h");
    expect(parseWindow("6h")).toBe("1h");
    expect(parseSort("errors")).toBe("errors");
    expect(parseSort("bogus")).toBe("count");
  });
});

describe("маршруты", () => {
  const items = [
    route({ route: "/api/a", requests: 10, p95: 40, errors4xx: 30 }),
    route({ route: "/api/b", requests: 50, p95: 900, errors5xx: 1 }),
    route({ route: "/api/c", requests: 5, p95: null }),
  ];

  test("по числу, по p95 (пустые в конце), по ошибкам — пятисотки впереди 4xx", () => {
    expect(sortRoutes(items, "count").map((r) => r.route)).toEqual(["/api/b", "/api/a", "/api/c"]);
    expect(sortRoutes(items, "p95").map((r) => r.route)).toEqual(["/api/b", "/api/a", "/api/c"]);
    // одна пятисотка важнее тридцати отказов «нет прав»
    expect(sortRoutes(items, "errors").map((r) => r.route)).toEqual(["/api/b", "/api/a", "/api/c"]);
    expect(sortMetric(items[0]!, "errors")).toBe(30);
  });

  test("поиск — по методу и шаблону, без учёта регистра", () => {
    expect(filterRoutes(items, "API/B").map((r) => r.route)).toEqual(["/api/b"]);
    expect(filterRoutes(items, "get /api/c")).toHaveLength(1);
    expect(filterRoutes(items, "  ")).toHaveLength(3);
  });
});

describe("лента", () => {
  test("новые сверху, без повторов на стыке, не длиннее потолка", () => {
    const prev = [line(3), line(2), line(1)];
    const next = mergeFeed(prev, [line(3), line(4), line(5)]);
    expect(next.map((l) => l.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(mergeFeed(next, [line(6)], 3).map((l) => l.seq)).toEqual([6, 5, 4]);
  });

  test("поля строкой «ключ=значение», номер запроса — укороченным", () => {
    expect(fieldsText({ method: "GET", status: 200, nested: { a: 1 } })).toBe('method=GET status=200 nested={"a":1}');
    expect(shortId("0123456789abcdef")).toBe("01234567");
    expect(shortId("short")).toBe("short");
  });
});

describe("графики", () => {
  const bucket = (min: number, requests: number, p95: number | null): OpsTrafficBucket => ({
    at: new Date(Date.UTC(2026, 8, 26, 12, min)).toISOString(),
    requests,
    errors4xx: 0,
    errors5xx: 0,
    avgMs: requests ? 10 : null,
    maxMs: requests ? 50 : null,
    p50: requests ? 8 : null,
    p95,
    p99: requests ? 60 : null,
  });
  const buckets = [bucket(0, 3, 40), bucket(1, 0, null), bucket(2, 5, 45)];

  test("столбцы — каждая корзина, в том числе пустая: ноль запросов — это тоже ответ", () => {
    const cols = trafficColumns(buckets, (iso) => iso.slice(11, 16));
    expect(cols.map((c) => c.value)).toEqual([3, 0, 5]);
    expect(cols[2]!.label).toBe("12:02");
  });

  test("линия p95 — только там, где были запросы, с полосой p50…p99", () => {
    const pts = latencySeries(buckets, (iso) => iso.slice(11, 16));
    expect(pts).toEqual([
      { x: "12:00", y: 40, lo: 8, hi: 60 },
      { x: "12:02", y: 45, lo: 8, hi: 60 },
    ]);
  });
});

describe("проверки здоровья", () => {
  test("у каждой пары «проверка + причина» с сервера есть фраза", () => {
    const fromServer: [OpsHealthCheck["key"], string][] = [
      ["db", "up"],
      ["db", "down"],
      ["rls", "active"],
      ["rls", "bypass"],
      ["rls", "unknown"],
      ["migrations", "current"],
      ["migrations", "pending"],
      ["migrations", "unknown"],
      ["scheduler", "fresh"],
      ["scheduler", "stale"],
      ["scheduler", "never"],
      ["scheduler", "disabled"],
      ["encryption", "set"],
      ["encryption", "missing"],
      ["errorReport", "set"],
      ["errorReport", "missing"],
      ["metricsToken", "set"],
      ["metricsToken", "missing"],
      ["errorRate", "low"],
      ["errorRate", "high"],
      ["errorRate", "quiet"],
    ];
    for (const [key, reason] of fromServer) {
      expect(healthReason({ key, status: "ok", reason }), `${key}.${reason}`).not.toBeNull();
      expect(HEALTH_NAME[key]).toBeTruthy();
    }
    // сервер новее консоли — статус без пояснения, а не чужое пояснение
    expect(healthReason({ key: "db", status: "ok", reason: "teleported" })).toBeNull();
    expect(Object.keys(CONN_KEY)).toContain("hidden");
  });
});

describe("числа", () => {
  test("байты — степенями 1024, как pg_size_pretty", () => {
    expect(bytesUnit(512)).toEqual({ value: 512, unit: "byte" });
    expect(bytesUnit(1536)).toEqual({ value: 1.5, unit: "kilobyte" });
    expect(bytesUnit(5 * 1024 ** 3).unit).toBe("gigabyte");
    expect(fmtBytes(1536, "en-GB")).toContain("1.5");
    expect(fmtBytes(null, "uk-UA")).toBe("—");
  });

  test("доля до процента — с десятой: иначе редкие пятисотки печатались бы нулём", () => {
    expect(fmtShare(0.004, "en-GB")).toBe("0.4%");
    expect(fmtShare(0.25, "en-GB")).toBe("25%");
    expect(fmtShare(null, "en-GB")).toBe("—");
    expect(fmtMs(null, "uk-UA")).toBe("—");
    expect(fmtMs(1234, "en-GB")).toContain("1,234");
  });

  test("время работы — две старшие единицы; «давно» — относительно переданного «сейчас»", () => {
    expect(fmtUptime(3 * 86_400 + 4 * 3600, "en-GB")).toMatch(/^3 .+ 4 /);
    expect(fmtUptime(42, "en-GB")).toMatch(/^42/);
    const now = Date.UTC(2026, 8, 26, 12, 0, 0);
    expect(fmtAgo(new Date(now - 5 * 60_000).toISOString(), now, "en-GB")).toBe("5 minutes ago");
    expect(fmtAgo(null, now, "en-GB")).toBe("—");
  });
});

describe("ошибки", () => {
  test("поиск идёт и по номеру последнего запроса", () => {
    const g = {
      fingerprint: "f",
      origin: "request" as const,
      name: "TypeError",
      message: "x is not a function",
      method: "GET",
      route: "/api/y",
      code: 500,
      count: 2,
      firstAt: "2026-09-26T10:00:00.000Z",
      lastAt: "2026-09-26T11:00:00.000Z",
      lastRequestId: "req-777",
      frames: [],
    };
    expect(filterErrors([g], "REQ-777")).toHaveLength(1);
    expect(filterErrors([g], "/api/z")).toHaveLength(0);
  });
});

/**
 * Сторож оформления: вкладки техпанели написаны в языке Polypsy с нуля, и
 * наследию в них взяться неоткуда — кроме копирования со старого экрана.
 * Проверяется ровно правило брифа: ни одного класса «Пульта» и ни одного
 * инлайнового стиля, кроме значений из рантайма (ширина полоски).
 */
describe("вкладки техпанели без наследия", () => {
  const FILES = ["Overview", "Requests", "Errors", "Logs", "Database", "Jobs", "parts"].map((n) =>
    resolve(import.meta.dir, `../src/pages/ops/${n}.tsx`),
  );
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

  test("инлайновый стиль — только ширина из данных", () => {
    const styles = FILES.flatMap((file) => [...readFileSync(file, "utf8").matchAll(/style=\{\{([^}]*)\}\}/g)].map((m) => m[1]!.trim()));
    expect(styles.every((s) => s.startsWith("width:"))).toBe(true);
  });
});
