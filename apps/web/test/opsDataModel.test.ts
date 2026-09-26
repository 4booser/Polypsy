import { describe, expect, test } from "bun:test";
import { UI, type DataCheck, type DataCheckKey, type UsageReport } from "@quizzy/shared";
import {
  CHECK_KIND,
  CHECK_TEXT,
  bySurveyHref,
  checkSummary,
  conversion,
  dayColumns,
  exampleHref,
  extraRows,
  funnelSteps,
  lagParts,
  lateParts,
  maybeDayColumns,
  pushCodeHint,
  pushErrors,
} from "../src/pages/ops/data/model";

/**
 * Техпанель «Дані й продукт»: правила, по которым экран читает отчёты.
 *
 * Главное здесь — два инварианта, которые экран легко нарушить незаметно:
 * скрытое порогом не превращается в ноль (ни в столбце, ни в доле), и
 * ссылка из примера ведёт на обычный экран консоли, а не открывает запись
 * мимо прав.
 */

const ALL_KEYS: DataCheckKey[] = [
  "orphans.responseNoVersion",
  "orphans.responseForeignVersion",
  "orphans.answerForeignQuestion",
  "orphans.scoreForeignScale",
  "orphans.surveyDanglingVersion",
  "orphans.keyAcrossVersions",
  "scoring.noScores",
  "scoring.noBands",
  "scores.unnormalized",
  "answers.missing",
  "responses.duplicates",
  "responses.stale",
];

describe("проверки качества", () => {
  test("у каждой проверки есть название, «чем опасно» и вид объекта", () => {
    for (const key of ALL_KEYS) {
      expect(UI[CHECK_TEXT[key].title], key).toBeDefined();
      expect(UI[CHECK_TEXT[key].danger], key).toBeDefined();
      expect(["response", "survey"]).toContain(CHECK_KIND[key]);
    }
    // названия разные: две проверки под одним именем на экране не различить
    expect(new Set(ALL_KEYS.map((k) => CHECK_TEXT[k].title)).size).toBe(ALL_KEYS.length);
  });

  test("пример ведёт на протокол или в конструктор, а не в техпанель", () => {
    expect(exampleHref({ id: "r1", kind: "response", surveyId: "s1" })).toBe("/surveys/s1/responses/r1");
    expect(exampleHref({ id: "s1", kind: "survey", surveyId: "s1" })).toBe("/constructor/s1");
  });

  test("разбивка по методикам: нормы — для ненормированных, конструктор — для содержимого", () => {
    expect(bySurveyHref("scores.unnormalized", "s1")).toBe("/surveys/s1/norms");
    expect(bySurveyHref("scoring.noBands", "s1")).toBe("/constructor/s1");
    expect(bySurveyHref("orphans.keyAcrossVersions", "s1")).toBe("/constructor/s1");
    expect(bySurveyHref("responses.duplicates", "s1")).toBe("/surveys/s1");
  });

  test("сводка считает сработавшие по уровням и чистые отдельно", () => {
    const checks: Pick<DataCheck, "level" | "count">[] = [
      { level: "error", count: 3 },
      { level: "error", count: 0 },
      { level: "warning", count: 1 },
      { level: "warning", count: 2 },
      { level: "info", count: 0 },
    ];
    expect(checkSummary(checks)).toEqual({ error: 1, warning: 2, info: 0, clean: 2 });
  });

  test("доп. числа — в смысловом порядке и только с подписью", () => {
    const rows = extraRows({ gte30d: 4, lt1d: 1, abandoned: 2, inProgress: 3, lt7d: 0, lt30d: 5, mystery: 9 });
    expect(rows.map((r) => r.key)).toEqual(["inProgress", "abandoned", "lt1d", "lt7d", "lt30d", "gte30d"]);
    // ноль печатается: пустая корзина давности — тоже ответ
    expect(rows.find((r) => r.key === "lt7d")?.value).toBe(0);
    for (const r of rows) expect(UI[r.label]).toBeDefined();
  });
});

describe("воронка", () => {
  const funnel = (over: Partial<UsageReport["funnel"]>): UsageReport["funnel"] => ({
    days: 90,
    invites: 40,
    registered: 20,
    firstResponse: 15,
    repeatResponse: 8,
    selfRegistered: 6,
    ...over,
  });

  test("доля — от предыдущей показанной ступени", () => {
    const steps = funnelSteps(funnel({}));
    expect(steps.map((s) => s.conversion)).toEqual([null, 50, 75, 53]);
  });

  test("скрытая ступень не даёт доли, следующая считается от последней показанной", () => {
    const steps = funnelSteps(funnel({ firstResponse: null }));
    expect(steps[2]!.value).toBeNull();
    expect(steps[2]!.conversion).toBeNull();
    // повторное — от зарегистрировавшихся: обе величины напечатаны, доля ничего не открывает
    expect(steps[3]!.conversion).toBe(40);
  });

  test("доля от скрытого — прочерк, а не число", () => {
    expect(conversion(null, 5)).toBeNull();
    expect(conversion(10, null)).toBeNull();
    // от нуля доли нет: деление на ноль — не «0%»
    expect(conversion(0, 0)).toBeNull();
    expect(conversion(8, 6)).toBe(75);
  });
});

describe("ряды по дням", () => {
  const rows = [
    { date: "2026-09-24", staff: 3, patients: 12 as number | null },
    { date: "2026-09-25", staff: 0, patients: null },
    { date: "2026-09-26", staff: 5, patients: 0 },
  ];

  test("скрытый день остаётся null, а не становится нулём", () => {
    const cols = maybeDayColumns(rows, (r) => r.patients, (d) => d.slice(8));
    expect(cols.map((c) => c.value)).toEqual([12, null, 0]);
    expect(cols.map((c) => c.label)).toEqual(["24", "25", "26"]);
  });

  test("обычный ряд — все дни на месте, пустой день нулём", () => {
    const cols = dayColumns(rows, (r) => r.staff, (d) => d);
    expect(cols).toHaveLength(3);
    expect(cols[1]).toEqual({ key: "2026-09-25", label: "2026-09-25", value: 0 });
  });
});

describe("мобильное приложение", () => {
  test("опоздание — в минутах, часах или днях; пустая выборка — null", () => {
    expect(lagParts(null)).toBeNull();
    // сорок секунд — «1 хв», а не «0»: досылка опаздывала
    expect(lagParts(40_000)).toEqual({ n: 1, unit: "opsd.lag.min" });
    expect(lagParts(25 * 60_000)).toEqual({ n: 25, unit: "opsd.lag.min" });
    expect(lagParts(5 * 3_600_000)).toEqual({ n: 5, unit: "opsd.lag.h" });
    expect(lagParts(3 * 86_400_000)).toEqual({ n: 3, unit: "opsd.lag.d" });
  });

  test("корзины опоздания идут от светлой к тёмной в порядке сервера", () => {
    const parts = lateParts([
      { key: "lt1h", count: 5 },
      { key: "lt1d", count: 2 },
      { key: "lt7d", count: 1 },
      { key: "gte7d", count: 0 },
    ]);
    expect(parts.map((p) => p.step)).toEqual([0, 1 / 3, 2 / 3, 1]);
    for (const p of parts) expect(UI[p.label]).toBeDefined();
  });
});

describe("пуши", () => {
  test("ошибки — отказ Expo, сбой отправки и отказ в квитанции", () => {
    expect(
      pushErrors({ sent: 10, accepted: 7, rejected: 2, failed: 1, delivered: 5, receiptErrors: 1, awaitingReceipt: 1 }),
    ).toBe(4);
  });

  test("пояснение есть у известных кодов, у чужого — честное молчание", () => {
    expect(pushCodeHint("DeviceNotRegistered")).toBe("opsd.code.deviceNotRegistered");
    expect(pushCodeHint("http_502")).toBe("opsd.code.http");
    expect(pushCodeHint("network")).toBe("opsd.code.network");
    expect(pushCodeHint("SomethingNew")).toBeNull();
  });
});
