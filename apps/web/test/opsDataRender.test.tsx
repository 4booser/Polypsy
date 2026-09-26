import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { DataCheck, MobileReport, PushReport, UsageReport } from "@quizzy/shared";
import { LangProvider } from "../src/lang";
import { MobileBody } from "../src/pages/ops/data/Mobile";
import { PushBody } from "../src/pages/ops/data/Push";
import { QualityBody } from "../src/pages/ops/data/Quality";
import { UsageBody } from "../src/pages/ops/data/Usage";

/**
 * Разделы «Дані й продукт» рисуются на краях: пустая база, скрытые порогом
 * числа, сработавшие и чистые проверки. Экран, который падает на «ещё ничего
 * не было», в техпанели хуже пустого — его открывают как раз тогда, когда
 * что-то пошло не так.
 */
const draw = (node: ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <LangProvider>{node}</LangProvider>
    </MemoryRouter>,
  );

const days = (values: number[]) =>
  values.map((v, i) => ({ date: `2026-09-${String(20 + i).padStart(2, "0")}`, v }));

describe("якість даних", () => {
  const fired: DataCheck = {
    key: "responses.duplicates",
    level: "warning",
    count: 2,
    examples: [{ id: "aaaaaaaa-1111-4000-8000-000000000001", kind: "response", surveyId: "s-1" }],
    bySurvey: [{ surveyId: "s-1", title: "PHQ-9", count: 2 }],
    extra: {},
  };
  const clean: DataCheck = { key: "scoring.noBands", level: "warning", count: 0, examples: [], bySurvey: [], extra: {} };

  test("пример — ссылкой на протокол, чистая проверка — одной строкой", () => {
    const html = draw(<QualityBody checkedAt="2026-09-26T10:00:00.000Z" checks={[fired, clean]} />);
    expect(html).toContain('href="/surveys/s-1/responses/aaaaaaaa-1111-4000-8000-000000000001"');
    expect(html).toContain('href="/analytics/tests?view=quality"');
    expect(html).toContain("PHQ-9");
    // пример показан коротко, полностью — в подсказке
    expect(html).toContain(">aaaaaaaa<");
  });
});

describe("використання", () => {
  const report: UsageReport = {
    days: 7,
    smallCellFloor: 5,
    screens: {
      total: 12,
      top: [{ app: "console", route: "/patients/:userId", views: 12, days: 3 }],
      byDay: days([0, 4, 8]).map((d) => ({ date: d.date, views: d.v })),
    },
    active: {
      byDay: [
        { date: "2026-09-20", staff: 2, patients: null },
        { date: "2026-09-21", staff: 3, patients: 7 },
      ],
      staff7: 4,
      staff30: 6,
      patients7: null,
      patients30: 11,
    },
    funnel: { days: 90, invites: 10, registered: null, firstResponse: null, repeatResponse: null, selfRegistered: 0 },
  };

  test("шаблон маршрута печатается как есть, скрытые — прочерком", () => {
    const html = draw(<UsageBody data={report} days={7} onDays={() => {}} />);
    expect(html).toContain("/patients/:userId");
    expect(html).toContain('role="img"');
    // скрытое порогом — прочерк у плитки, черта у оси в графике, а не ноль
    expect(html).toContain(">—<");
    expect(html).toContain('stroke="var(--axis)"');
  });

  test("пустое окно не роняет экран", () => {
    const empty: UsageReport = {
      ...report,
      screens: { total: 0, top: [], byDay: [] },
      active: { byDay: [], staff7: 0, staff30: 0, patients7: 0, patients30: 0 },
    };
    expect(() => draw(<UsageBody data={empty} days={30} onDays={() => {}} />)).not.toThrow();
  });
});

describe("мобільний застосунок і пуші", () => {
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
    queue: { devicesReporting: 2, pending: 3, rejected: 1, devicesWithPending: 1, devicesWithRejected: 1 },
    late: {
      total: 0,
      submitted: 0,
      buckets: [
        { key: "lt1h", count: 0 },
        { key: "lt1d", count: 0 },
        { key: "lt7d", count: 0 },
        { key: "gte7d", count: 0 },
      ],
      medianLagMs: null,
      p90LagMs: null,
      byDay: [],
    },
  };

  test("версии, очередь и пустая выборка опозданий", () => {
    const html = draw(<MobileBody data={mobile} days={90} onDays={() => {}} />);
    expect(html).toContain("1.1.0");
    expect(html).toContain("1.2.0");
  });

  const push: PushReport = {
    days: 30,
    since: null,
    totals: { sent: 0, accepted: 0, rejected: 0, failed: 0, delivered: 0, receiptErrors: 0, awaitingReceipt: 0 },
    byDay: [],
    byKind: [],
    errors: [],
    tokens: { registered: 0, stale: 0, byPlatform: [] },
    events: [],
  };

  test("пуши до первой отправки — пояснение, а не пустые нули", () => {
    const html = draw(<PushBody data={push} days={30} onDays={() => {}} />);
    expect(html).toContain("0091");
  });

  test("коды ошибок печатаются, токенов нет", () => {
    const html = draw(
      <PushBody
        data={{
          ...push,
          since: "2026-09-01T00:00:00Z",
          totals: { ...push.totals, sent: 4, accepted: 3, failed: 1 },
          errors: [{ code: "DeviceNotRegistered", count: 1, tokens: 1 }],
          byKind: [{ kind: "appointment", sent: 4, errors: 1, delivered: 2 }],
        }}
        days={30}
        onDays={() => {}}
      />,
    );
    expect(html).toContain("DeviceNotRegistered");
    expect(html).not.toContain("ExponentPushToken");
  });
});
