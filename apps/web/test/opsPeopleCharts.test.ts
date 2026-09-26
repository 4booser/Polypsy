import { describe, expect, test } from "bun:test";
import { UI, type AuditDaily, type MfaCoverageRow, type OpsUsersRoleSummary, type UiKey, type WhoViewedReport } from "@quizzy/shared";
import {
  ageParts,
  auditColumns,
  coverageBars,
  findingColumns,
  grantParts,
  loginColumns,
  mfaParts,
  newAccountColumns,
  ruleBars,
  sessionRoleBars,
  stateParts,
  topWithOthers,
  weekColumns,
  whoViewedActions,
  whoViewedDays,
} from "../src/pages/ops/people2/model";

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

describe("сводка реестра", () => {
  const patients: OpsUsersRoleSummary = {
    role: "user",
    total: 40,
    states: [
      { key: "active", count: 30 },
      { key: "never", count: null },
      { key: "locked", count: 0 },
      { key: "disabled", count: null },
    ],
    mfa: null,
  };

  test("состояния — в постоянном порядке, скрытое — null, а не ноль; тон темнеет к «діє»", () => {
    const parts = stateParts(patients, ut);
    expect(parts.map((p) => p.key)).toEqual(["active", "never", "locked", "disabled"]);
    expect(parts.map((p) => p.value)).toEqual([30, null, 0, null]);
    expect(parts[0]!.label).toBe(UI["opsp.state.active"].uk);
    expect(parts[0]!.step).toBe(1);
    expect(parts.at(-1)!.step).toBe(0);
    for (let i = 1; i < parts.length; i++) expect(parts[i]!.step!).toBeLessThan(parts[i - 1]!.step!);
  });

  test("второй фактор: «є» и «немає» из действующих; больше, чем всего, не бывает", () => {
    expect(mfaParts({ enabled: 2, total: 5 }, ut).map((p) => p.value)).toEqual([2, 3]);
    expect(mfaParts({ enabled: 3, total: 2 }, ut).map((p) => p.value)).toEqual([3, 0]);
  });

  test("новые по неделям: неделя пациентов под порогом остаётся null, персонал — числом", () => {
    const cols = newAccountColumns(
      [
        { week: "2026-09-14", staff: 2, patients: null },
        { week: "2026-09-21", staff: 0, patients: 7 },
      ],
      iso,
    );
    expect(cols.map((c) => c.values)).toEqual([
      [2, null],
      [0, 7],
    ]);
    expect(cols[0]!.label).toBe("«2026-09-14»");
    expect(cols[0]!.key).toBe("2026-09-14");
  });

  test("входы: удачные — первой частью (снизу), неудачные — второй", () => {
    expect(loginColumns([{ date: "2026-09-26", success: 9, failed: 2 }], iso)[0]!.values).toEqual([9, 2]);
  });
});

describe("сессии", () => {
  test("роль — полосой, скрытые пациенты — прочерком без полосы", () => {
    const bars = sessionRoleBars(
      [
        { role: "superadmin", sessions: 2 },
        { role: "admin", sessions: 14 },
        { role: "user", sessions: null },
      ],
      (r) => r,
    );
    expect(bars.map((b) => b.value)).toEqual([2, 14, null]);
  });

  test("возраст — от свежих к старым, подписи словаря", () => {
    const parts = ageParts(
      [
        { key: "day", count: 3 },
        { key: "week", count: null },
        { key: "month", count: 0 },
        { key: "older", count: null },
      ],
      ut,
    );
    expect(parts.map((p) => p.label)).toEqual(["day", "week", "month", "older"].map((k) => UI[`opsp.age.${k}` as UiKey].uk));
    expect(parts.map((p) => p.value)).toEqual([3, null, 0, null]);
  });
});

describe("журнал во времени", () => {
  test("удачные снизу, отказы и сбои сверху; подпись знает шаг", () => {
    const daily: AuditDaily = {
      step: "month",
      from: "2024-01-01",
      to: "2026-09-26",
      buckets: [{ start: "2026-08-01", ok: 120, refused: 4 }],
    };
    const cols = auditColumns(daily, (d, step) => `${step}:${d}`);
    expect(cols).toEqual([{ key: "2026-08-01", label: "month:2026-08-01", values: [120, 4] }]);
  });
});

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

  test("по дням: разобранные снизу, нерозібрані сверху", () => {
    expect(findingColumns([{ date: "2026-09-26", open: 1, resolved: 5 }], iso)[0]!.values).toEqual([5, 1]);
  });

  test("исключения: четыре состояния в постоянном порядке, выдачи — столбцами по неделям", () => {
    const parts = grantParts({ active: 3, permanent: 7, expired: 2, revoked: 1, byWeek: [] }, ut);
    expect(parts.map((p) => [p.key, p.value])).toEqual([
      ["active", 3],
      ["permanent", 7],
      ["expired", 2],
      ["revoked", 1],
    ]);
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

describe("охват вторым фактором", () => {
  const row = (because: MfaCoverageRow["because"], enabled: boolean, disabled = false): MfaCoverageRow => ({
    id: crypto.randomUUID(),
    email: "x@test",
    fullName: "X",
    role: because === "superadmin" ? "superadmin" : "admin",
    because,
    enabled,
    confirmedAt: enabled ? "2026-09-01T00:00:00Z" : null,
    disabled,
  });

  test("доля — из действующих: выключенный без фактора её не портит", () => {
    const bars = coverageBars([row("superadmin", true), row("superadmin", false, true), row("ops", true), row("ops", false), row("ops", false)], ut);
    expect(bars.map((b) => [b.key, b.value])).toEqual([
      ["superadmin", 100],
      ["ops", 33],
    ]);
    expect(bars[1]!.text).toBe(`1 ${UI["an.of"].uk} 3 · 33%`);
    // неполный охват — жирным: на него смотрят, включая требование
    expect(bars[0]!.strong).toBe(false);
    expect(bars[1]!.strong).toBe(true);
  });

  test("группа без действующих учёток не рисуется: 0 % соврал бы, что все без фактора", () => {
    expect(coverageBars([row("ops", false, true)], ut)).toEqual([]);
    expect(coverageBars([], ut)).toEqual([]);
  });
});
