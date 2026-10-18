import { describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { UI, type DataCheck, type MobileReport, type PushReport, type UsageReport } from "@quizzy/shared";
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

/** Строка словаря до первой подстановки — на любом из трёх языков */
const head = (key: keyof typeof UI) => [UI[key].uk, UI[key].ru, UI[key].en].map((s) => s.split("{")[0]!.trim());
const has = (html: string, key: keyof typeof UI) => expect(head(key).some((h) => html.includes(h)), key).toBe(true);
const hasNot = (html: string, key: keyof typeof UI) => expect(head(key).some((h) => html.includes(h)), key).toBe(false);

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

  test("находка — строкой таблицы с уровнем словом, пример — ссылкой на протокол, чистая — в своей панели", () => {
    const html = draw(<QualityBody checks={[fired, clean]} />);
    // первая находка раскрыта: пример виден коротко, полностью — в подсказке
    expect(html).toContain('href="/surveys/s-1/responses/aaaaaaaa-1111-4000-8000-000000000001"');
    expect(html).toContain(">aaaaaaaa<");
    expect(html).toContain('href="/analytics/tests?view=quality"');
    expect(html).toContain("PHQ-9");
    // разбивка по методикам ведёт туда, где несостыковку чинят
    expect(html).toContain('href="/surveys/s-1"');
    // уровень — словом, не только цветом
    has(html, "opsd.level.warning");
    // чистая — строкой в панели «Чисто», а не пустым разделом
    has(html, "opsd.chk.noBands");
    expect(html).toContain('aria-expanded="true"');
  });

  test("вкладка «Чисто» не показывает находок, вкладка уровня — только свой уровень", () => {
    const onlyClean = draw(<QualityBody checks={[fired, clean]} view="clean" />);
    hasNot(onlyClean, "opsd.chk.duplicates");
    has(onlyClean, "opsd.chk.noBands");

    const errors = draw(<QualityBody checks={[fired, clean]} view="error" />);
    hasNot(errors, "opsd.chk.duplicates");
    has(errors, "oppd.q.noFindings");
  });

  test("единица при числе — по правилу числа: одна методика, а не «1 методик»", () => {
    const one: DataCheck = {
      key: "orphans.keyAcrossVersions",
      level: "error",
      count: 1,
      examples: [{ id: "s-9", kind: "survey", surveyId: "s-9" }],
      bySurvey: [],
      extra: {},
    };
    const html = draw(<QualityBody checks={[one]} />);
    has(html, "oppd.unit.survey.one");
    // пример методики ведёт в конструктор
    expect(html).toContain('href="/constructor/s-9"');
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
      byApp: [{ app: "console", views: 12 }],
      routes: 1,
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

  test("шаблон маршрута печатается как есть, скрытое порогом — «n < 5», а не ноль", () => {
    const html = draw(<UsageBody data={report} />);
    expect(html).toContain("/patients/:userId");
    expect(html).toContain('role="img"');
    // скрытое порогом — ячейка «n < 5» с объяснением, а не ноль и не пустота
    expect(html).toContain("n &lt; 5");
    // день, где пациентов меньше порога, — разрыв линии: следующий день стоит одиночной меткой
    expect(html).toContain("data-single");
  });

  test("пустое окно не роняет экран", () => {
    const empty: UsageReport = {
      ...report,
      screens: { total: 0, top: [], byDay: [], byApp: [], routes: 0 },
      active: { byDay: [], staff7: 0, staff30: 0, patients7: 0, patients30: 0 },
    };
    expect(() => draw(<UsageBody data={empty} />)).not.toThrow();
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

  test("версии, старые сборки заметкой, очередь и пустая выборка опозданий", () => {
    const html = draw(<MobileBody data={mobile} />);
    expect(html).toContain("1.1.0");
    expect(html).toContain("1.2.0");
    // одно устройство на старой сборке — формой «один», а не «1 пристроїв»
    has(html, "oppd.m.oldTitle.one");
    // отклонённые ждут человека — об этом сказано словами
    has(html, "oppd.m.rejectedNote");
    // падения — у раздела ошибок клиента, сюда ведёт ссылка
    expect(html).toContain('href="/ops/client-errors"');
  });

  const push: PushReport = {
    days: 30,
    since: null,
    totals: { sent: 0, accepted: 0, rejected: 0, failed: 0, delivered: 0, receiptErrors: 0, awaitingReceipt: 0 },
    byDay: [],
    byKind: [],
    errors: [],
    tokens: { registered: 0, stale: 0, byPlatform: [], oldest: [] },
    events: [],
  };

  test("пуши до первой отправки — пояснение, а не пустые нули", () => {
    const html = draw(<PushBody data={push} />);
    expect(html).toContain("0091");
  });

  test("путь — таблицей этапов с долей от предыдущего; коды ошибок печатаются, токенов нет — только отпечатки", () => {
    const html = draw(
      <PushBody
        now={Date.parse("2026-10-08T12:00:00Z")}
        data={{
          ...push,
          since: "2026-09-01T00:00:00Z",
          totals: { ...push.totals, sent: 4, accepted: 3, failed: 1, delivered: 3 },
          errors: [{ code: "DeviceNotRegistered", count: 1, tokens: 1 }],
          byKind: [{ kind: "appointment", sent: 4, errors: 1, delivered: 2 }],
          events: [{ kind: "appointment", count: 2 }],
          tokens: {
            registered: 2,
            stale: 1,
            byPlatform: [{ platform: "ios", count: 2 }],
            oldest: [{ platform: "ios", fingerprint: "a91f00112233402c", lastSeenAt: "2026-06-02T10:00:00Z" }],
          },
        }}
      />,
    );
    expect(html).toContain("DeviceNotRegistered");
    expect(html).not.toContain("ExponentPushToken");
    // этапы пути — строками таблицы, а не плитками
    expect(html).toContain("<table");
    has(html, "oppd.p.path");
    has(html, "opsd.p.accepted");
    // 3 из 4 принято — доля от предыдущего этапа
    expect(html).toMatch(/75 %/);
    // отпечаток — коротко, начало и конец; сам токен на его месте закрыт замком
    expect(html).toContain("a91f…402c");
    has(html, "oppd.masked");
  });
});
