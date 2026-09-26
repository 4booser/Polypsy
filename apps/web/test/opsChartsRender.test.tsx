import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type OpsErrors, type OpsJob, type OpsLogVolume, type OpsRouteCompare, type OpsStatement, type OpsTrafficBucket, type UiKey } from "@quizzy/shared";
import { HBars, PairBars, ShareBar, StackColumns, TimeColumns, TimeLines } from "../src/charts/clinical";
import { LangProvider } from "../src/lang";
import { ErrorCharts, JobCharts, LogVolumeCharts, RouteCharts, TableCharts, TrafficCharts } from "../src/pages/ops/charts";
import { ReleaseCharts, StatementCharts, TraceTime } from "../src/pages/ops/obs2a/charts";

/**
 * Графики техпанели (волна 11) рисуются на краях: пустое окно, корзины до
 * запуска процесса, разрыв ряда, ни одной пятисотки, история без часов.
 * Как в clinicalCharts.test.tsx — разметка получилась, в ней нет NaN, янтарь
 * стоит ровно там, где что-то требует внимания, и пустое сказано словами.
 */
const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

/** Строка словаря на любом из языков: язык теста решает окружение, а не проверка */
const says = (html: string, key: UiKey) => {
  const e = UI[key] as { uk: string; ru: string; en: string };
  return [e.uk, e.ru, e.en].some((s) => html.includes(s));
};

const countOf = (html: string, needle: string) => html.split(needle).length - 1;

describe("формы набора", () => {
  const series = [
    { key: "ok", label: "ok", color: "var(--primary)" },
    { key: "c5", label: "c5", color: "var(--accent)" },
  ];

  test("столбцы с разбивкой: корзина без замера — без столбца; часть в один запрос видна", () => {
    const html = draw(
      <StackColumns
        label="L"
        series={series}
        columns={[
          { key: "a", label: "a", values: null },
          { key: "b", label: "b", values: [3000, 1] },
          { key: "c", label: "c", values: [0, 0] },
        ]}
      />,
    );
    expect(html).not.toContain("NaN");
    expect(countOf(html, 'fill="var(--accent)"')).toBe(1);
    expect(countOf(html, 'fill="var(--primary)"')).toBe(1);
    // легенда из двух рядов — строками словаря рядов
    expect(html).toContain(">ok<");
    expect(html).toContain(">c5<");
  });

  test("столбцы с разбивкой без единого замера — «нет данных», а не пустые оси", () => {
    const html = draw(<StackColumns label="L" series={series} columns={[{ key: "a", label: "a", values: null }]} />);
    expect(html).not.toContain("<svg");
  });

  test("линии рвутся на пропуске; одиночная корзина — точкой; выше порога — янтарная точка", () => {
    const html = draw(
      <TimeLines
        label="L"
        x={["a", "b", "c", "d", "e", "f"].map((k) => ({ key: k, label: k }))}
        series={[{ key: "s", label: "s", color: "var(--primary)", values: [0.001, 0.002, null, 0.05, null, 0.003] }]}
        threshold={{ value: 0.01, label: "поріг" }}
      />,
    );
    expect(html).not.toContain("NaN");
    // один отрезок из двух корзин — линией, две одиночные — точками
    expect(countOf(html, 'stroke="var(--primary)" stroke-width="2"')).toBe(1);
    expect(countOf(html, 'r="2.5"')).toBe(2);
    expect(countOf(html, 'fill="var(--accent)"')).toBe(1);
    expect(html).toContain('stroke-dasharray="3 4"');
  });

  test("линии без единого значения — «нет данных»", () => {
    const html = draw(<TimeLines label="L" x={[{ key: "a", label: "a" }]} series={[{ key: "s", label: "s", color: "var(--primary)", values: [null] }]} />);
    expect(html).not.toContain("<svg");
  });

  test("столбцы: тон внимания — янтарь; корзина без замера — без столбца", () => {
    const html = draw(
      <TimeColumns
        label="L"
        tone="attention"
        columns={[
          { key: "a", label: "a", value: null },
          { key: "b", label: "b", value: 4 },
        ]}
      />,
    );
    expect(countOf(html, "<rect")).toBe(1);
    expect(html).toContain('fill="var(--accent)"');
  });

  test("пары: «стало» янтарём только у отмеченной строки; нулевой полосы нет", () => {
    const html = draw(
      <PairBars
        before="було"
        after="стало"
        rows={[
          { key: "a", label: "a", before: 100, after: 400, text: "100 → 400", attention: true },
          { key: "b", label: "b", before: 200, after: 0, text: "200 → 0" },
          { key: "c", label: "c", before: null, after: 50, text: "— → 50" },
        ]}
      />,
    );
    expect(countOf(html, "background:var(--accent)")).toBe(1);
    // до: a, b (c — null); после: a (янтарь), c; у b «стало» — ноль, полосы нет
    expect(countOf(html, "background:var(--primary)")).toBe(2);
    expect(html).toContain("було");
    expect(html).not.toContain("NaN");
  });

  test("полосы: тон внимания; доли — своим форматом, без повторного процента", () => {
    expect(draw(<HBars items={[{ key: "a", label: "a", value: 3, attention: true }]} />)).toContain("bg-accent");
    const html = draw(
      <ShareBar
        label="L"
        format={(v) => `${Math.round(v * 100)} %`}
        percent={false}
        parts={[
          { key: "a", label: "a", value: 0.25 },
          { key: "b", label: "b", value: 0.75, color: "var(--grid)" },
        ]}
      />,
    );
    expect(html).toContain("25 %");
    expect(html).toContain("background:var(--grid)");
    expect(html).not.toContain("· 25%");
  });
});

const bucket = (min: number, requests: number, c5 = 0): OpsTrafficBucket => ({
  at: new Date(Date.UTC(2026, 8, 26, 12, min)).toISOString(),
  requests,
  errors4xx: requests ? 1 : 0,
  errors5xx: c5,
  avgMs: requests ? 20 : null,
  maxMs: requests ? 90 : null,
  p50: requests ? 15 : null,
  p95: requests ? 60 : null,
  p99: requests ? 80 : null,
});

describe("блоки вкладок", () => {
  const buckets = [bucket(0, 0), bucket(1, 30, 2), bucket(2, 0), bucket(3, 12)];
  const since = new Date(Date.UTC(2026, 8, 26, 12, 1)).toISOString();

  test("нагрузка: четыре фигуры на «Огляді», две на «Запитах»", () => {
    const full = draw(<TrafficCharts buckets={buckets} stepSec={60} since={since} />);
    expect(full).not.toContain("NaN");
    expect(countOf(full, "<figure")).toBe(4);
    expect(says(full, "ops.ch.class.c5")).toBe(true);
    const compact = draw(<TrafficCharts buckets={buckets} stepSec={60} since={since} compact />);
    expect(countOf(compact, "<figure")).toBe(2);
  });

  test("маршруты без пятисоток и без выборки для p95 — словами", () => {
    const html = draw(
      <RouteCharts
        items={[
          { method: "GET", route: "/api/x", requests: 3, errors4xx: 0, errors5xx: 0, share5xx: 0, avgMs: 5, p50: 5, p95: 9, p99: 9, maxMs: 9 },
        ]}
      />,
    );
    expect(says(html, "ops.ch.routes5xxNone")).toBe(true);
    expect(html).toContain("/api/x");
  });

  const errors: OpsErrors = {
    since,
    capacity: 200,
    dropped: 0,
    items: [
      {
        fingerprint: "f1",
        origin: "request",
        name: "TypeError",
        message: "boom",
        method: "GET",
        route: "/api/x",
        code: 500,
        count: 7,
        firstAt: since,
        lastAt: since,
        lastRequestId: null,
        frames: [],
      },
    ],
  };

  test("ошибки без часов истории — график времени словами, группы — полосой", () => {
    const html = draw(<ErrorCharts data={errors} window="24h" now={Date.parse(since)} />);
    expect(says(html, "ops.ch.errNoHours")).toBe(true);
    expect(html).toContain("TypeError");
    expect(html).toContain("bg-accent");
  });

  test("ошибки с часами истории — янтарные столбцы по часам периода", () => {
    const now = Date.parse(since);
    const data = { ...errors, from: new Date(now - 86_400_000).toISOString(), hours: [{ at: new Date(now - 3_600_000).toISOString(), count: 7 }] };
    const html = draw(<ErrorCharts data={data} window="24h" now={now} />);
    expect(html).toContain('fill="var(--accent)"');
    expect(html).not.toContain("NaN");
  });

  test("лог без предупреждений и ошибок — вторая фигура словами", () => {
    const now = Date.parse(since);
    const volume: OpsLogVolume = {
      window: "1h",
      from: new Date(now - 3_600_000).toISOString(),
      grain: "minute",
      buckets: [{ at: new Date(now - 120_000).toISOString(), debug: 0, info: 40, warn: 0, error: 0 }],
      store: { running: true, lastFlushAt: null, lastError: null, lastErrorAt: null, pendingLogs: 0, droppedLogs: 0 },
      historyUnavailable: false,
    };
    const html = draw(<LogVolumeCharts volume={volume} now={now} />);
    expect(says(html, "ops.ch.logQuiet")).toBe(true);
    expect(html).not.toContain("NaN");
    const loud = draw(
      <LogVolumeCharts volume={{ ...volume, buckets: [{ ...volume.buckets[0]!, warn: 2, error: 1 }] }} now={now} />,
    );
    expect(loud).toContain('fill="var(--accent)"');
    expect(loud).toContain('fill="var(--series-quiet)"');
  });

  test("задачи без сбоев — «збоїв не було», янтаря нет", () => {
    const job: OpsJob = {
      name: "schedules",
      intervalSec: 60,
      runs: 12,
      failures: 0,
      skipped: 0,
      lastStartAt: since,
      lastEndAt: since,
      lastDurationMs: 40,
      lastResult: "ok",
      lastError: null,
      lastErrorAt: null,
      nextAt: null,
      manual: false,
      lastByHand: false,
    };
    const html = draw(<JobCharts items={[job]} />);
    expect(says(html, "ops.ch.jobNoFails")).toBe(true);
    expect(html).not.toContain("bg-accent");
  });

  test("мёртвые строки: янтарь только у таблицы, где автоочистка не успевает", () => {
    const t = (table: string, dead: number, live: number) => ({
      table,
      totalBytes: 1024 * 1024,
      tableBytes: 0,
      indexBytes: 0,
      liveRows: live,
      deadRows: dead,
      seqScan: null,
      idxScan: null,
      lastAutovacuum: null,
      lastAutoanalyze: null,
    });
    const html = draw(<TableCharts tables={[t("hot", 5000, 1000), t("calm", 10, 100_000)]} />);
    expect(countOf(html, "bg-accent")).toBe(1);
  });
});

describe("блоки obs2a", () => {
  const side = (p95: number, errors5xx = 0, requests = 100) => ({ requests, errors5xx, share5xx: errors5xx / requests, p50: p95 / 2, p95 });

  test("выкатка без сравнимых маршрутов — словами; с ухудшением — янтарь и слово", () => {
    const few: OpsRouteCompare[] = [{ method: "GET", route: "/x", before: side(10), after: side(20), latency: "few", errors: "few" }];
    expect(says(draw(<ReleaseCharts items={few} />), "ops.ch.relFew")).toBe(true);
    const worse: OpsRouteCompare[] = [{ method: "GET", route: "/x", before: side(100), after: side(400, 9), latency: "worse", errors: "worse" }];
    const html = draw(<ReleaseCharts items={worse} />);
    expect(html).toContain("background:var(--accent)");
    expect(says(html, "ops.rel.worse")).toBe(true);
  });

  test("SQL: полосы по порядку и доля времени базы с «рештою»", () => {
    const st = (id: string, share: number | null): OpsStatement => ({ id, calls: 3, totalMs: 30, meanMs: 10, rows: 1, share, query: `select ${id} from t` });
    const html = draw(<StatementCharts items={[st("1", 0.5), st("2", 0.2)]} sort="total" />);
    expect(html).toContain("select 1 from t");
    expect(says(html, "ops.ch.sqlRest")).toBe(true);
    expect(html).not.toContain("NaN");
    // без долей — только полосы
    expect(countOf(draw(<StatementCharts items={[st("1", null)]} sort="calls" />), "<figure")).toBe(1);
  });

  test("трасса: полоса времени — только когда SQL измерен", () => {
    const s = { at: "2026-09-26T12:00:00.000Z", method: "GET", route: "/x", status: 200, ms: 100, role: null, sqlCount: 2, sqlMs: 25 };
    expect(draw(<TraceTime summary={s} />)).toContain('role="img"');
    expect(draw(<TraceTime summary={{ ...s, sqlMs: null }} />)).toBe("");
  });
});
