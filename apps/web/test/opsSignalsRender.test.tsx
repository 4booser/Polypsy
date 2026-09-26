import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type MobileReport, type OpsAlertHistory, type OpsClientErrorGroup, type OpsIntegrityState, type OpsVitalRoute, type PushReport, type ReleaseEntry, type UsageReport } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { MobileBody } from "../src/pages/ops/data/Mobile";
import { PushBody } from "../src/pages/ops/data/Push";
import { UsageBody } from "../src/pages/ops/data/Usage";
import { Cadence } from "../src/pages/ops/maint/Releases";
import { HistoryShape } from "../src/pages/ops/obs2b/Alerts";
import { ErrorShape } from "../src/pages/ops/obs2b/ClientErrors";
import { lastDays, localDay } from "../src/pages/ops/obs2b/model";
import { VitalShape } from "../src/pages/ops/obs2b/Vitals";
import { ChainHistory } from "../src/pages/ops/sec/Integrity";

/**
 * Графики сигналов (волна 11) рисуются на краях: пустой месяц, один день,
 * невычислимая доля, разрыв цепочки. Как у соседних тестов разметки:
 * разметка получилась, в ней нет NaN, «undefined» и неподставленных
 * {скобок}, у графика есть role="img", а главные слова стоят на месте.
 */

const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const clean = (html: string) => {
  expect(html).not.toContain("NaN");
  expect(html).not.toContain("undefined");
  expect(html).not.toMatch(/\{(n|days|metric|good|poor|weeks|g|r)\}/);
};

/** Строка словаря до первой подстановки: ищется в разметке на любом языке */
const head = (key: keyof typeof UI) => [UI[key].uk, UI[key].ru, UI[key].en].map((s) => s.split("{")[0]!.trim());
const has = (html: string, key: keyof typeof UI) => expect(head(key).some((h) => html.includes(h)), key).toBe(true);

const NOW = Date.now();
const days30 = lastDays(NOW, 30);

describe("сповіщення: форма истории", () => {
  const h: OpsAlertHistory = {
    items: [],
    days: 30,
    daily: days30.map((date, i) => ({ date, fired: i === 28 ? 2 : 0, repeat: i === 28 ? 4 : 0, resolved: i === 29 ? 1 : 0 })),
    byRule: [{ rule: "errors5xx", fired: 2, repeat: 4 }],
  };

  test("столбцы парой и правила полосами", () => {
    const html = draw(<HistoryShape h={h} />);
    clean(html);
    expect(html).toContain('role="img"');
    has(html, "sig.al.byDay");
    has(html, "o2b.rule.errors5xx");
    // слово ряда в легенде, а не только цвет
    has(html, "o2b.event.fired");
    has(html, "o2b.event.resolved");
    // янтарь — у сбоя
    expect(html).toContain("var(--accent)");
  });

  test("пустой месяц — фразой, без осей", () => {
    const html = draw(<HistoryShape h={{ ...h, daily: h.daily.map((d) => ({ ...d, fired: 0, repeat: 0, resolved: 0 })), byRule: [] }} />);
    has(html, "sig.al.quiet");
    expect(html).not.toContain("<svg");
  });
});

describe("помилки клієнта: форма списка", () => {
  const g = (over: Partial<OpsClientErrorGroup>): OpsClientErrorGroup => ({
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
    count: 3,
    firstAt: new Date(NOW - 86_400_000).toISOString(),
    lastAt: new Date(NOW).toISOString(),
    frames: [],
    ...over,
  });

  test("новые по дням, экраны, группы и доли по браузеру и системе", () => {
    const items = [g({}), g({ route: "/patients/:id", count: 7, browser: null, os: "Android", platform: "mobile" })];
    const html = draw(<ErrorShape items={items} retentionDays={90} now={NOW} />);
    has(html, "sig.ce.newByDay");
    has(html, "sig.ce.byScreen");
    expect(html).toContain("/patients/:id");
    // мобилка без браузера — «не відомо», а не пустая часть
    has(html, "sig.ce.unknown");
    expect(html.match(/role="img"/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("все группы старше окна — фраза вместо пустых столбцов", () => {
    const html = draw(<ErrorShape items={[g({ firstAt: "2026-01-01T10:00:00Z" })]} retentionDays={90} now={NOW} />);
    has(html, "sig.ce.noNew");
  });
});

describe("швидкість екранів: над таблицей", () => {
  const routes: OpsVitalRoute[] = [
    {
      route: "/today",
      metrics: { LCP: { p75: 4200, n: 12, rating: "poor", daily: [], ratings: { good: 3, needs: 4, poor: 5 } } },
    },
  ];

  test("медленные экраны и доли замеров по оценке — словами", () => {
    const html = draw(<VitalShape routes={routes} metric="LCP" onMetric={() => {}} days={30} />);
    clean(html);
    expect(html).toContain("/today");
    has(html, "o2b.rating.good");
    has(html, "o2b.rating.poor");
    // мало замеров — сказано рядом с числом
    has(html, "o2b.v.few");
  });

  test("по мере нет замеров ни у одного экрана — фраза", () => {
    const html = draw(<VitalShape routes={routes} metric="CLS" onMetric={() => {}} days={30} />);
    has(html, "o2b.v.noMetric");
  });
});

describe("випуски: частота", () => {
  const rel = (startedAt: string): ReleaseEntry => ({
    id: crypto.randomUUID(),
    version: "v1",
    commitSha: null,
    commitUrl: null,
    deployedBy: null,
    runUrl: null,
    startedAt,
    endedAt: null,
    migrations: [],
    lastMigration: null,
  });

  test("столбцы по неделям и среднее числом", () => {
    const html = draw(<Cadence items={[rel(new Date(NOW).toISOString()), rel(new Date(NOW - 20 * 86_400_000).toISOString())]} now={NOW} />);
    clean(html);
    expect(html).toContain('role="img"');
    has(html, "sig.rl.perWeek");
  });

  test("одна неделя — не ряд: графика нет", () => {
    expect(draw(<Cadence items={[rel(new Date(NOW).toISOString())]} now={NOW} />)).toBe("");
  });
});

describe("цілісність: полоса сверок", () => {
  const state = (history: OpsIntegrityState["auditHistory"]): OpsIntegrityState => ({
    rls: null,
    audit: null,
    auditScheduled: null,
    scheduleHours: 24,
    nextScheduledAfter: new Date(NOW).toISOString(),
    historyDays: 30,
    auditHistory: history,
  });

  test("разрыв — ромбом и словами, с датой", () => {
    const brokenAt = new Date(NOW - 2 * 86_400_000).toISOString();
    const html = draw(
      <ChainHistory
        now={NOW}
        state={state([
          { at: brokenAt, ok: false, trigger: "schedule" },
          { at: new Date(NOW - 3600_000).toISOString(), ok: true, trigger: "manual" },
        ])}
      />,
    );
    clean(html);
    expect(html).toContain('role="img"');
    has(html, "sig.int.brokenDays");
    has(html, "sig.int.notChecked");
    expect(html).toContain("rotate-45 bg-danger");
    // день разрыва — в полосе по часам экрана
    expect(days30).toContain(localDay(brokenAt));
  });

  test("сверок в окне нет — полосы нет", () => {
    expect(draw(<ChainHistory now={NOW} state={state([])} />)).toBe("");
  });
});

describe("дані й продукт: добавленные графики", () => {
  test("використання: экраны полосами и «інші» до итога окна", () => {
    const report: UsageReport = {
      days: 7,
      smallCellFloor: 5,
      screens: {
        total: 50,
        top: [{ app: "console", route: "/patients/:userId", views: 12, days: 3 }],
        byDay: [{ date: "2026-09-26", views: 50 }],
      },
      active: { byDay: [], staff7: 1, staff30: 1, patients7: null, patients30: null },
      funnel: { days: 90, invites: 0, registered: null, firstResponse: null, repeatResponse: null, selfRegistered: null },
    };
    const html = draw(<UsageBody data={report} days={7} onDays={() => {}} />);
    clean(html);
    has(html, "sig.u.topScreens");
    has(html, "sig.u.otherScreens");
    expect(html).toContain(">38<");
  });

  test("пуши: доля ошибок по дням — только при отправках", () => {
    const push: PushReport = {
      days: 30,
      since: "2026-09-01T00:00:00Z",
      totals: { sent: 4, accepted: 3, rejected: 0, failed: 1, delivered: 2, receiptErrors: 0, awaitingReceipt: 0 },
      byDay: [
        { date: "2026-09-25", sent: 0, errors: 0 },
        { date: "2026-09-26", sent: 4, errors: 1 },
      ],
      byKind: [],
      errors: [{ code: "DeviceNotRegistered", count: 1, tokens: 1 }],
      tokens: { registered: 0, stale: 0, byPlatform: [] },
      events: [],
    };
    const html = draw(<PushBody data={push} days={30} onDays={() => {}} />);
    clean(html);
    has(html, "sig.p.share");
    has(html, "sig.p.codes");
    const none = draw(<PushBody data={{ ...push, byDay: push.byDay.map((d) => ({ ...d, sent: 0, errors: 0 })) }} days={30} onDays={() => {}} />);
    expect(head("sig.p.share").some((h) => none.includes(h))).toBe(false);
  });

  test("мобільний: версии полосой, старая — словом «застаріла»", () => {
    const mobile: MobileReport = {
      days: 90,
      devices: { total: 3, known: 2, unknown: 1 },
      newest: "1.2.0",
      versions: [
        { platform: "ios", version: "1.2.0", build: "14", devices: 1, old: false, lastSeenAt: "2026-09-26T08:00:00Z" },
        { platform: "android", version: "1.1.0", build: null, devices: 1, old: true, lastSeenAt: "2026-09-20T08:00:00Z" },
        { platform: null, version: null, build: null, devices: 1, old: false, lastSeenAt: "2026-09-01T08:00:00Z" },
      ],
      old: { devices: 1, percent: 50 },
      queue: { devicesReporting: 0, pending: 0, rejected: 0, devicesWithPending: 0, devicesWithRejected: 0 },
      late: { total: 0, submitted: 0, buckets: [], medianLagMs: null, p90LagMs: null, byDay: [] },
    };
    const html = draw(<MobileBody data={mobile} days={90} onDays={() => {}} />);
    clean(html);
    has(html, "sig.m.versions");
    has(html, "sig.m.unknownVersion");
    has(html, "opsd.m.oldTag");
  });
});
