import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { MobileVersionRow, OpsAlertHistory, OpsClientErrorGroup, OpsRecordings, OpsVitalRoute } from "@quizzy/shared";
import { cmpVersion, errorShare, topScreens, versionParts } from "../src/pages/ops/data/model";
import { perWeek, weekOf, weeklyDeploys } from "../src/pages/ops/maint/model";
import {
  ALERT_SERIES,
  REST_KEY,
  alertGroups,
  anyAlerts,
  browserFamily,
  diskParts,
  lastDays,
  localDay,
  newGroupsByDay,
  rankBy,
  ratingTotals,
  slowestRoutes,
  statusParts,
  topGroups,
} from "../src/pages/ops/obs2b/model";
import { checkDays } from "../src/pages/ops/sec/model";

/**
 * Графики сигналов техпанели (волна 11): ряды считаются здесь, чистыми
 * функциями, и проверяются на краях — пустой день, пустой период, «інші»,
 * невычислимое. Экран только рисует: ошибка в ряду — это неправда на
 * графике, и найти её глазами труднее, чем тестом.
 */

/** Момент по местным часам — тест не зависит от пояса машины */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).toISOString();

describe("дни по часам экрана", () => {
  test("день момента — по местному календарю", () => {
    expect(localDay(new Date(2026, 8, 26, 23, 30))).toBe("2026-09-26");
    expect(localDay(new Date(2026, 0, 1, 0, 5).getTime())).toBe("2026-01-01");
  });

  test("последние дни — календарём: через переход часов ни одного дня дважды и ни одного пропуска", () => {
    // в конце октября часы переводят назад: сутки длятся 25 часов
    const days = lastDays(new Date(2026, 9, 27, 0, 30).getTime(), 5);
    expect(days).toEqual(["2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27"]);
    // и через границу месяца и года
    expect(lastDays(new Date(2027, 0, 2, 9).getTime(), 3)).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
  });
});

describe("сповіщення: форма истории", () => {
  const daily: OpsAlertHistory["daily"] = [
    { date: "2026-09-24", fired: 0, repeat: 0, resolved: 0 },
    { date: "2026-09-25", fired: 2, repeat: 5, resolved: 1 },
    { date: "2026-09-26", fired: 0, repeat: 0, resolved: 1 },
  ];

  test("пара рядов «збій» и «відновлено»; повтор в столбцы не идёт", () => {
    const groups = alertGroups(daily, (d) => d.slice(8));
    expect(groups.map((g) => g.label)).toEqual(["24", "25", "26"]);
    expect(groups[1]!.values).toEqual({ fired: 2, resolved: 1 });
    expect(ALERT_SERIES.map((s) => [s.key, s.tone])).toEqual([
      ["fired", "fail"],
      ["resolved", "ok"],
    ]);
  });

  test("пустой месяц — словами, а не пустыми осями", () => {
    expect(anyAlerts(daily)).toBe(true);
    expect(anyAlerts(daily.map((d) => ({ ...d, fired: 0, repeat: 0, resolved: 0 })))).toBe(false);
    // одни повторы — тоже событие: инцидент шёл
    expect(anyAlerts([{ date: "x", fired: 0, repeat: 3, resolved: 0 }])).toBe(true);
  });
});

const group = (over: Partial<OpsClientErrorGroup>): OpsClientErrorGroup => ({
  fingerprint: crypto.randomUUID(),
  platform: "web",
  kind: "error",
  name: "TypeError",
  message: "x is undefined",
  route: "/today",
  apiMethod: null,
  apiRoute: null,
  status: null,
  release: null,
  browser: "Chrome 128",
  os: "Windows",
  count: 1,
  firstAt: at(2026, 9, 25),
  lastAt: at(2026, 9, 26),
  frames: [],
  ...over,
});

describe("помилки клієнта: форма списка", () => {
  test("новые группы — по дню первого появления; вне окна — не считаются", () => {
    const days = ["2026-09-24", "2026-09-25", "2026-09-26"];
    const items = [
      group({ firstAt: at(2026, 9, 25, 9) }),
      group({ firstAt: at(2026, 9, 25, 22) }),
      group({ firstAt: at(2026, 9, 26, 0) }),
      group({ firstAt: at(2026, 8, 1) }),
    ];
    expect(newGroupsByDay(items, days)).toEqual([0, 2, 1]);
    expect(newGroupsByDay([], days)).toEqual([0, 0, 0]);
  });

  test("рейтинг: сумма случаев, первые N и остаток одной строкой; неизвестное — ключом «»", () => {
    const items = [
      group({ route: "/a", count: 10 }),
      group({ route: "/a", count: 5 }),
      group({ route: "/b", count: 7 }),
      group({ route: "/c", count: 2 }),
      group({ route: "/d", count: 1 }),
    ];
    const r = rankBy(items, (g) => g.route, 2);
    expect(r.top).toEqual([
      { key: "/a", value: 15, groups: 2 },
      { key: "/b", value: 7, groups: 1 },
    ]);
    expect(r.rest).toEqual({ key: REST_KEY, value: 3, groups: 2, keys: 2 });
    expect(rankBy(items, (g) => g.route, 10).rest).toBeNull();

    const browsers = rankBy([group({ browser: null, count: 4 }), group({ count: 1 })], (g) => browserFamily(g.browser), 5);
    expect(browsers.top.map((b) => b.key)).toEqual(["", "Chrome"]);
  });

  test("семейство браузера без версии; самые частые группы — по счётчику, при равенстве свежая выше", () => {
    expect(browserFamily("Chrome 128")).toBe("Chrome");
    expect(browserFamily("Safari")).toBe("Safari");
    expect(browserFamily(null)).toBeNull();
    const old = group({ count: 3, lastAt: at(2026, 9, 1) });
    const fresh = group({ count: 3, lastAt: at(2026, 9, 20) });
    const big = group({ count: 9 });
    expect(topGroups([old, fresh, big], 2)).toEqual([big, fresh]);
  });
});

describe("швидкість екранів: рейтинг и доли", () => {
  const cell = (p75: number | null, n: number, ratings = { good: 0, needs: 0, poor: 0 }) => ({
    p75,
    n,
    rating: p75 === null ? null : p75 <= 2500 ? ("good" as const) : p75 <= 4000 ? ("needs" as const) : ("poor" as const),
    daily: [],
    ratings,
  });
  const routes: OpsVitalRoute[] = [
    { route: "/today", metrics: { LCP: cell(1800, 50, { good: 45, needs: 4, poor: 1 }) } },
    { route: "/patients/:id", metrics: { LCP: cell(4200, 30, { good: 10, needs: 8, poor: 12 }) } },
    { route: "/rare", metrics: { LCP: cell(2600, 3, { good: 1, needs: 2, poor: 0 }) } },
    // у экрана нет этой меры — в рейтинг не входит, нулём в конце не стоит
    { route: "/inp-only", metrics: { INP: cell(180, 10) } },
  ];

  test("медленные сверху; без замеров меры — не в рейтинге; остаток — числом", () => {
    const s = slowestRoutes(routes, "LCP", 2);
    expect(s.rows.map((r) => r.route)).toEqual(["/patients/:id", "/rare"]);
    expect(s.rows[0]).toMatchObject({ p75: 4200, rating: "poor", n: 30 });
    expect(s.more).toBe(1);
    expect(slowestRoutes(routes, "CLS", 5)).toEqual({ rows: [], more: 0 });
  });

  test("доли — по замерам всех экранов, а не по экранам", () => {
    expect(ratingTotals(routes.map((r) => r.metrics.LCP))).toEqual({ good: 56, needs: 14, poor: 13 });
    expect(ratingTotals([undefined])).toEqual({ good: 0, needs: 0, poor: 0 });
  });
});

describe("записи прийомів: полосы", () => {
  const rec = (over: Partial<OpsRecordings> = {}): OpsRecordings => ({
    byStatus: [
      { status: "failed", count: 2, bytes: 0 },
      { status: "done", count: 40, bytes: 1000 },
      { status: "uploaded", count: 3, bytes: 300 },
      { status: "ready", count: 0, bytes: 0 },
    ],
    stored: { count: 43, bytes: 1300 },
    disk: { files: 43, bytes: 1300, truncated: false, totalBytes: 10_000, freeBytes: 6_000 },
    queue: { waiting: 3, transcribing: 0, oldestWaitingSec: null, stuck: 0 },
    failed: [],
    transcriberHere: false,
    ...over,
  });

  test("состояния — путём записи, сбой янтарём, пустые не рисуются", () => {
    const parts = statusParts(rec());
    expect(parts.map((p) => [p.status, p.value, p.tone])).toEqual([
      ["done", 40, "ok"],
      ["uploaded", 3, "ok"],
      ["failed", 2, "fail"],
    ]);
  });

  test("том: записи, прочее, свободно; не прочитан или обрезан — полосы нет", () => {
    expect(diskParts(rec())).toEqual({ records: 1300, other: 2700, free: 6000 });
    expect(diskParts(rec({ disk: null }))).toBeNull();
    expect(diskParts(rec({ disk: { files: 5000, bytes: 1, truncated: true, totalBytes: 10, freeBytes: 5 } }))).toBeNull();
    expect(diskParts(rec({ disk: { files: 1, bytes: 1, truncated: false, totalBytes: null, freeBytes: 5 } }))).toBeNull();
  });
});

describe("дані й продукт: пуши, экраны, версии", () => {
  test("доля ошибок: день без отправок — null, а не ноль; ошибок больше отправок не бывает больше 100 %", () => {
    const pts = errorShare(
      [
        { date: "2026-09-24", sent: 0, errors: 0 },
        { date: "2026-09-25", sent: 3, errors: 1 },
        { date: "2026-09-26", sent: 2, errors: 5 },
      ],
      (d) => d.slice(8),
    );
    expect(pts).toEqual([
      { key: "2026-09-24", label: "24", value: null },
      { key: "2026-09-25", label: "25", value: 33.3 },
      { key: "2026-09-26", label: "26", value: 100 },
    ]);
  });

  test("экраны: первые N и «інші» — от итога окна, а не от суммы топа", () => {
    const top = [
      { app: "console" as const, route: "/a", views: 5, days: 1 },
      { app: "console" as const, route: "/b", views: 20, days: 3 },
      { app: "patient" as const, route: "/c", views: 2, days: 1 },
    ];
    const t = topScreens(top, 100, 2);
    expect(t.rows.map((r) => r.route)).toEqual(["/b", "/a"]);
    expect(t.rest).toBe(75);
    // итог меньше суммы (окно сдвинулось между запросами) — остаток ноль, не минус
    expect(topScreens(top, 10, 3).rest).toBe(0);
  });

  test("версии сравниваются числами, а не строкой", () => {
    expect(cmpVersion("1.10.0", "1.9.3")).toBeGreaterThan(0);
    expect(cmpVersion("1.2", "1.2.0")).toBe(0);
    expect(cmpVersion("2.0.0-beta", "1.99")).toBeGreaterThan(0);
  });

  test("версии: платформы одной версии вместе, от новой к старым, хвост — «старіші», неизвестная — в конце", () => {
    const row = (version: string | null, devices: number, old: boolean, platform = "ios"): MobileVersionRow => ({
      platform,
      version,
      build: null,
      devices,
      old,
      lastSeenAt: "2026-09-26T08:00:00Z",
    });
    const parts = versionParts(
      [row("1.9.0", 2, true), row("1.10.0", 3, false), row("1.10.0", 4, false, "android"), row("1.8.0", 1, true), row("1.7.0", 1, true), row(null, 5, false)],
      2,
    );
    expect(parts.map((p) => [p.version, p.devices, p.old, p.rest ?? 0])).toEqual([
      ["1.10.0", 7, false, 0],
      ["1.9.0", 2, true, 0],
      [null, 2, true, 2],
      [null, 5, false, 0],
    ]);
    expect(versionParts([], 5)).toEqual([]);
  });
});

describe("випуски: частота по неделям", () => {
  test("неделя — с понедельника по местному календарю", () => {
    // 26.09.2026 — суббота, 28.09 — понедельник, 27.09 — воскресенье
    expect(weekOf(new Date(2026, 8, 26, 10))).toBe("2026-09-21");
    expect(weekOf(new Date(2026, 8, 27, 23))).toBe("2026-09-21");
    expect(weekOf(new Date(2026, 8, 28, 0, 5))).toBe("2026-09-28");
  });

  test("от недели самой старой выкладки до текущей; пауза — ноль в ряду; не длиннее предела", () => {
    const now = new Date(2026, 8, 30, 12).getTime();
    const items = [{ startedAt: at(2026, 9, 29) }, { startedAt: at(2026, 9, 28) }, { startedAt: at(2026, 9, 10) }, { startedAt: at(2026, 9, 9) }];
    const weeks = weeklyDeploys(items, now, 26);
    expect(weeks).toEqual([
      { key: "2026-09-07", value: 2 },
      { key: "2026-09-14", value: 0 },
      { key: "2026-09-21", value: 0 },
      { key: "2026-09-28", value: 2 },
    ]);
    expect(perWeek(weeks)).toBe(1);
    // предел: из полугода истории — последние две недели
    expect(weeklyDeploys(items, now, 2).map((w) => w.key)).toEqual(["2026-09-21", "2026-09-28"]);
    expect(weeklyDeploys([], now, 26)).toEqual([]);
    expect(perWeek([])).toBeNull();
  });
});

/**
 * Сторож оформления для графиков волны 11 — то же правило брифа, что у
 * вкладок ops и obs2b: ни одного класса наследия, ни одного хекса;
 * инлайновый стиль — только у самих графиков (charts.tsx) и только со
 * значениями из данных: ширина отрезка, положение подсказки, цвет части.
 */
describe("графики сигналов без наследия", () => {
  const src = (p: string) => readFileSync(resolve(import.meta.dir, "../src/pages/ops", p), "utf8");
  const CHARTS = "obs2b/charts.tsx";
  const SCREENS = ["data/Usage.tsx", "data/Push.tsx", "data/Mobile.tsx", "maint/Releases.tsx", "sec/Integrity.tsx", "sec/parts.tsx"];
  const LEGACY = new Set(["card", "tile", "row", "chip", "btn", "hint", "muted", "tabs", "grid-cols-2", "cols-2", "cols-3", "cols-4"]);

  test("нет классов наследия и хексов", () => {
    const found: string[] = [];
    for (const file of [CHARTS, ...SCREENS]) {
      const text = src(file);
      for (const m of text.matchAll(/className=\{?["'`]([^"'`]*)["'`]/g)) {
        for (const token of m[1]!.split(/\s+/)) if (LEGACY.has(token)) found.push(`${file}: ${token}`);
      }
      if (/#[0-9a-fA-F]{3,6}\b/.test(text.replace(/\/\*[\s\S]*?\*\//g, ""))) found.push(`${file}: hex`);
    }
    expect(found).toEqual([]);
  });

  test("инлайновый стиль — только в графиках и только ширина, положение и цвет из данных", () => {
    for (const file of SCREENS) expect(src(file).includes("style={{"), file).toBe(false);
    const keys = [...src(CHARTS).matchAll(/style=\{\{([^}]*)\}\}/g)].flatMap((m) => [...m[1]!.matchAll(/(\w+):/g)].map((k) => k[1]!));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !["width", "left", "background"].includes(k))).toEqual([]);
  });
});

describe("цілісність: сверки по дням", () => {
  test("итог дня — худший; день без сверок — «не звіряли», а не «цілий»", () => {
    const days = ["2026-09-24", "2026-09-25", "2026-09-26"];
    const history = [
      { at: "2026-09-25T08:00:00Z", ok: false },
      { at: "2026-09-25T18:00:00Z", ok: true },
      { at: "2026-09-26T08:00:00Z", ok: true },
      { at: "2026-08-01T08:00:00Z", ok: false },
    ];
    const out = checkDays(history, days, (iso) => iso.slice(0, 10));
    expect(out).toEqual([
      { key: "2026-09-24", ok: 0, broken: 0, state: "none" },
      { key: "2026-09-25", ok: 1, broken: 1, state: "broken" },
      { key: "2026-09-26", ok: 1, broken: 0, state: "ok" },
    ]);
  });
});
