import { describe, expect, test } from "bun:test";
import { UI, type UiKey, type WhoViewedReport } from "@quizzy/shared";
import { ruleBars, topWithOthers, weekColumns, whoViewedActions, whoViewedDays } from "../src/pages/ops/people2/model";

/**
 * Ряды графиков разделов людей техпанели (волна 11) без браузера.
 *
 * Главное здесь — то, что на графике выглядит правдоподобно и при этом
 * врёт: скрытое порогом, нарисованное нулём; пустой день, выпавший из оси
 * и сжавший время; хвост «інших», выброшенный молча; 0 % охвата у группы,
 * в которой никого нет.
 */

const ut = (key: UiKey) => UI[key].uk;
const iso = (s: string) => `«${s}»`;

describe("подозрительное и доступы", () => {
  test("правило с нерозібраними — жирным и с числом новых", () => {
    const bars = ruleBars(
      [
        { rule: "failedLoginsIp", total: 12, open: 3 },
        { rule: "nightActivity", total: 4, open: 0 },
      ],
      ut,
    );
    expect(bars[0]!.strong).toBe(true);
    expect(bars[0]!.text).toBe(`12 · ${UI["opsp.susp.newOf"].uk} 3`);
    expect(bars[1]!.strong).toBe(false);
    expect(bars[1]!.text).toBe("4");
    expect(bars[0]!.label).toBe(UI["ops.rule.failedLoginsIp"].uk);
  });

  test("выдачи — столбцами по неделям", () => {
    expect(weekColumns([{ week: "2026-09-21", count: 4 }], iso)).toEqual([{ key: "2026-09-21", label: "«2026-09-21»", value: 4 }]);
  });
});

describe("хто переглядав", () => {
  const report: WhoViewedReport = {
    patient: { id: "p", fullName: "Пацієнт", email: "p@test" },
    from: "2026-09-20",
    to: "2026-09-24",
    total: 9,
    generatedAt: "2026-09-25T10:00:00.000Z",
    actors: [
      {
        actorId: "a",
        actorEmail: "a@test",
        actorName: "А",
        actorRole: "admin",
        total: 6,
        days: [
          {
            day: "2026-09-20",
            actions: [
              { action: "patient.card_read", count: 4, first: "2026-09-20T08:00:00Z", last: "2026-09-20T09:00:00Z", asUserEmail: null },
              { action: "response.read", count: 1, first: "2026-09-20T08:00:00Z", last: "2026-09-20T08:00:00Z", asUserEmail: null },
            ],
          },
          {
            day: "2026-09-23",
            actions: [{ action: "patient.card_read", count: 1, first: "2026-09-23T08:00:00Z", last: "2026-09-23T08:00:00Z", asUserEmail: null }],
          },
        ],
      },
      {
        actorId: "b",
        actorEmail: "b@test",
        actorName: "Б",
        actorRole: "admin",
        total: 3,
        days: [
          {
            day: "2026-09-23",
            actions: [{ action: "analytics.export", count: 3, first: "2026-09-23T10:00:00Z", last: "2026-09-23T11:00:00Z", asUserEmail: null }],
          },
        ],
      },
    ],
  };

  test("дни — сплошным рядом от «з» до «по»: пустой день — ноль, а не дыра", () => {
    const cols = whoViewedDays(report, (d) => d);
    expect(cols.map((c) => [c.key, c.value])).toEqual([
      ["2026-09-20", 5],
      ["2026-09-21", 0],
      ["2026-09-22", 0],
      ["2026-09-23", 4],
      ["2026-09-24", 0],
    ]);
    expect(cols.reduce((s, c) => s + c.value, 0)).toBe(report.total);
  });

  test("перевёрнутый период — пусто; год и больше — не больше 366 столбцов", () => {
    expect(whoViewedDays({ ...report, from: "2026-09-24", to: "2026-09-20" }, (d) => d)).toEqual([]);
    expect(whoViewedDays({ ...report, from: "2020-01-01", to: "2026-09-24" }, (d) => d)).toHaveLength(366);
  });

  test("действия — по убыванию, человеческими словами", () => {
    const bars = whoViewedActions(report, (a) => `[${a}]`, "інші");
    expect(bars.map((b) => [b.label, b.value])).toEqual([
      ["[patient.card_read]", 5],
      ["[analytics.export]", 3],
      ["[response.read]", 1],
    ]);
  });

  test("«інші» складывают хвост: сумма та же, строк не больше заданного", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ key: `k${i}`, label: `r${i}`, value: i + 1 }));
    const bars = topWithOthers(rows, 8, "інші");
    expect(bars).toHaveLength(8);
    expect(bars.at(-1)!.label).toBe("інші");
    expect(bars.reduce((s, b) => s + (b.value ?? 0), 0)).toBe(rows.reduce((s, r) => s + r.value, 0));
    expect(bars[0]!.value).toBe(12);
    // восемь и меньше — без «інших»
    expect(topWithOthers(rows.slice(0, 8), 8, "інші").some((b) => b.label === "інші")).toBe(false);
  });
});
