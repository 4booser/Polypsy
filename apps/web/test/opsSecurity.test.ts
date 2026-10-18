import { describe, expect, test } from "bun:test";
import {
  UI,
  type MfaCoverageRow,
  type SuspiciousFinding,
  type SuspiciousThresholds,
  type UiKey,
  type WhoViewedActor,
  type WhoViewedReport,
} from "@quizzy/shared";
import { RULES } from "../src/pages/ops/people2/model";
import {
  actorAs,
  actorLast,
  actorLines,
  coverageGroups,
  daysUntil,
  elapsedPct,
  endingSoon,
  extendedUntil,
  findingChips,
  findingCounts,
  findingMatches,
  findingText,
  findingWho,
  findingsInWindow,
  hiddenDays,
  mfaViewRows,
  missingRequired,
  periodDays,
  periodOk,
  pluralForm,
  presetOf,
  presetPeriod,
  reportSummary,
  requiredBy,
  seenBeforePolicy,
  windowText,
} from "../src/pages/ops/people2/securityModel";

/**
 * Экраны безопасности техпанели в «Виразній» без браузера: кому по политике
 * нужен второй фактор, куда продлится доступ, сколько дней до выбранной
 * даты, что сказать о срабатывании и как сложить отчёт «хто переглядав».
 *
 * Главное — то, что на экране выглядело бы правдой и при этом врало:
 * суперадмин, которого «не касается» позначка для ops; продление истёкшего
 * доступа «от старого конца»; фраза срабатывания с незаполненной скобкой.
 */

const ut = (key: UiKey) => UI[key].uk;
const KYIV = "Europe/Kyiv";

const TH: SuspiciousThresholds = {
  failedPerAccount: 5,
  failedPerIp: 10,
  failedIpAccounts: 3,
  failedWindowMin: 15,
  massReadPatients: 25,
  massReadWindowMin: 15,
  nightFrom: "21:00",
  nightTo: "07:00",
  nightMinReads: 3,
  timezone: KYIV,
  hoursSource: "schedule",
};

function finding(partial: Partial<SuspiciousFinding> & Pick<SuspiciousFinding, "rule">): SuspiciousFinding {
  return {
    id: "f1",
    actorId: "u1",
    actorEmail: "doc@test",
    actorName: "Мазур Олена",
    subjectId: null,
    subjectName: null,
    ip: null,
    windowFrom: "2026-10-08T11:05:00.000Z",
    windowTo: "2026-10-08T11:35:00.000Z",
    hits: 34,
    details: null,
    detectedAt: "2026-10-08T12:00:00.000Z",
    notified: false,
    resolvedAt: null,
    resolvedByEmail: null,
    resolution: null,
    ...partial,
  };
}

const row = (because: MfaCoverageRow["because"], enabled: boolean, disabled = false, id: string = crypto.randomUUID()): MfaCoverageRow => ({
  id,
  email: `${id}@test`,
  fullName: id,
  role: because === "superadmin" ? "superadmin" : "admin",
  because,
  enabled,
  confirmedAt: enabled ? "2026-09-01T00:00:00Z" : null,
  disabled,
  lastSeenAt: null,
});

describe("другий фактор", () => {
  test("суперадмина касается и позначка для ops: он держит все права", () => {
    expect(requiredBy({ because: "superadmin" }, { superadmins: false, ops: true })).toBe(true);
    expect(requiredBy({ because: "superadmin" }, { superadmins: true, ops: false })).toBe(true);
    expect(requiredBy({ because: "ops" }, { superadmins: true, ops: false })).toBe(false);
    expect(requiredBy({ because: "ops" }, { superadmins: false, ops: false })).toBe(false);
  });

  test("без фактора и обязателен — только действующие: выключенный в настройку не упрётся", () => {
    const rows = [row("superadmin", false, false, "s1"), row("ops", false, true, "o1"), row("ops", true, false, "o2"), row("ops", false, false, "o3")];
    expect(missingRequired(rows, { superadmins: false, ops: true }).map((r) => r.id)).toEqual(["s1", "o3"]);
    expect(missingRequired(rows, { superadmins: true, ops: false }).map((r) => r.id)).toEqual(["s1"]);
    expect(missingRequired(rows, { superadmins: false, ops: false })).toEqual([]);
  });

  test("доля: полностью — зелёным, обязательно и неполно — янтарём, весь персонал — для справки", () => {
    const rows = [row("superadmin", true), row("superadmin", true), row("ops", true), row("ops", false), row("ops", false, true)];
    const groups = coverageGroups(rows, { total: 20, enabled: 15 }, { superadmins: true, ops: true });
    expect(groups).toEqual([
      { key: "superadmin", on: 2, total: 2, tone: "good" },
      { key: "ops", on: 1, total: 2, tone: "warn" },
      { key: "staff", on: 15, total: 20, tone: "plain" },
    ]);
    // требование выключено — неполная доля не «внимание», а просто доля
    expect(coverageGroups(rows, undefined, { superadmins: false, ops: false }).find((g) => g.key === "ops")?.tone).toBe("plain");
    // группа без действующих учёток не рисуется: доли от нуля нет
    expect(coverageGroups([row("ops", false, true)], { total: 0, enabled: 0 }, { superadmins: false, ops: true })).toEqual([]);
  });

  test("«останній вхід був до вимоги» — только когда оба момента известны", () => {
    expect(seenBeforePolicy("2026-10-07T09:00:00Z", "2026-10-08T13:20:00Z")).toBe(true);
    expect(seenBeforePolicy("2026-10-08T14:00:00Z", "2026-10-08T13:20:00Z")).toBe(false);
    expect(seenBeforePolicy(null, "2026-10-08T13:20:00Z")).toBe(false);
    expect(seenBeforePolicy("2026-10-07T09:00:00Z", null)).toBe(false);
  });

  test("подання: «не налаштовано» без выключенных, по причине — все строки причины", () => {
    const rows = [row("superadmin", false), row("ops", false, true), row("ops", true)];
    expect(mfaViewRows(rows, "missing")).toHaveLength(1);
    expect(mfaViewRows(rows, "ops")).toHaveLength(2);
    expect(mfaViewRows(rows, "superadmin")).toHaveLength(1);
    expect(mfaViewRows(rows, "all")).toHaveLength(3);
  });
});

describe("тимчасові доступи", () => {
  const now = Date.parse("2026-10-08T14:00:00.000Z");

  test("продление — от нынешнего конца, а у истёкшего — от «сейчас», как у сервера", () => {
    expect(extendedUntil("2026-10-08T19:00:00.000Z", 7, now)).toBe("2026-10-15T19:00:00.000Z");
    expect(extendedUntil("2026-10-01T19:00:00.000Z", 1, now)).toBe("2026-10-09T14:00:00.000Z");
  });

  test("дней до выбранной даты: сегодня и прошлое — нет, дальше года — нет", () => {
    const today = new Date(2026, 9, 8, 15, 30);
    expect(daysUntil("2026-10-08", today)).toBeNull();
    expect(daysUntil("2026-10-07", today)).toBeNull();
    expect(daysUntil("2026-10-09", today)).toBe(1);
    expect(daysUntil("2026-11-07", today)).toBe(30);
    expect(daysUntil("2027-10-08", today)).toBe(365);
    expect(daysUntil("2027-10-09", today)).toBeNull();
    expect(daysUntil("8.10.2026", today)).toBeNull();
  });

  test("прошедшая часть срока и «закінчуються протягом доби»", () => {
    expect(elapsedPct({ grantedAt: "2026-10-01T14:00:00.000Z", expiresAt: "2026-10-15T14:00:00.000Z" }, now)).toBe(50);
    expect(elapsedPct({ grantedAt: "2026-10-08T14:00:00.000Z", expiresAt: "2026-10-08T14:00:00.000Z" }, now)).toBe(100);
    expect(
      endingSoon(
        [{ expiresAt: "2026-10-08T19:00:00.000Z" }, { expiresAt: "2026-10-09T13:00:00.000Z" }, { expiresAt: "2026-10-10T14:00:00.000Z" }, { expiresAt: "2026-10-08T13:00:00.000Z" }],
        now,
      ),
    ).toBe(2);
  });
});

describe("підозріла активність", () => {
  test("у каждого правила — фраза без незаполненных скобок, числа — с сервера", () => {
    for (const rule of RULES) {
      const text = findingText(finding({ rule, details: { accounts: 4, client: "Chrome · Windows", patients: 2, reason: "звернення 212" }, subjectName: "Коваль Марта" }), TH, ut, "uk", KYIV);
      expect(text, rule).not.toMatch(/\{\w+\}/);
      expect(text.length, rule).toBeGreaterThan(5);
    }
    expect(findingText(finding({ rule: "massReads" }), TH, ut, "uk", KYIV)).toContain("25");
    expect(findingText(finding({ rule: "massReads" }), TH, ut, "uk", KYIV)).toContain("30");
    expect(findingText(finding({ rule: "impersonation", subjectName: "Коваль Марта", details: { reason: "звернення 212" } }), TH, ut, "uk", KYIV)).toContain("«звернення 212»");
    expect(findingText(finding({ rule: "impersonation", subjectName: "Коваль Марта" }), TH, ut, "uk", KYIV)).not.toContain("«");
  });

  test("пилюли: окно первым, сверх порога — янтарём, адрес серии по адресу не повторяется", () => {
    const mass = findingChips(finding({ rule: "massReads", ip: "198.51.100.40", details: { reads: 41 } }), TH, ut, "uk", KYIV);
    expect(mass[0]).toMatchObject({ key: "window", icon: "clock", text: "08.10, 14:05–14:35" });
    expect(mass.find((c) => c.key === "patients")).toMatchObject({ tone: "warn", text: "пацієнтів 34, поріг 25" });
    expect(mass.at(-1)).toMatchObject({ key: "ip", mono: true, text: "198.51.100.40" });
    const ip = findingChips(finding({ rule: "failedLoginsIp", ip: "203.0.113.47", details: { accounts: 9 } }), TH, ut, "uk", KYIV);
    expect(ip.some((c) => c.key === "ip")).toBe(false);
    for (const c of [...mass, ...ip]) expect(c.text, c.key).not.toMatch(/\{\w+\}/);
  });

  test("окно серии: в пределах дня — одним днём, через полночь — двумя, момент — моментом", () => {
    expect(windowText("2026-10-08T11:05:00.000Z", "2026-10-08T11:35:00.000Z", "uk", KYIV)).toBe("08.10, 14:05–14:35");
    expect(windowText("2026-10-07T20:10:00.000Z", "2026-10-07T22:40:00.000Z", "uk", KYIV)).toBe("07.10, 23:10 – 08.10, 01:40");
    expect(windowText("2026-10-08T11:05:00.000Z", "2026-10-08T11:05:00.000Z", "uk", KYIV)).toBe("08.10, 14:05");
  });

  test("кто: у серии по адресу — адрес, иначе имя, иначе почта", () => {
    expect(findingWho(finding({ rule: "failedLoginsIp", ip: "203.0.113.47" }))).toBe("203.0.113.47");
    expect(findingWho(finding({ rule: "newDevice" }))).toBe("Мазур Олена");
    expect(findingWho(finding({ rule: "newDevice", actorName: null }))).toBe("doc@test");
  });

  test("счёт для отбора и за окно графика; поиск — по человеку, адресу и клиенту", () => {
    expect(findingCounts({ open: 1, total: 14 })).toEqual({ open: 1, resolved: 13, total: 14 });
    expect(findingsInWindow([{ date: "2026-10-07", open: 0, resolved: 2 }, { date: "2026-10-08", open: 1, resolved: 0 }])).toBe(3);
    const f = finding({ rule: "newDevice", ip: "10.0.0.7", details: { client: "Edge · Windows" } });
    expect(findingMatches(f, "мазур")).toBe(true);
    expect(findingMatches(f, "10.0.0")).toBe(true);
    expect(findingMatches(f, "edge")).toBe(true);
    expect(findingMatches(f, "Бондар")).toBe(false);
    expect(findingMatches(f, "  ")).toBe(true);
  });
});

describe("хто переглядав", () => {
  const actor = (id: string, days: WhoViewedActor["days"]): WhoViewedActor => ({
    actorId: id,
    actorEmail: `${id}@test`,
    actorName: id,
    actorRole: "admin",
    total: days.reduce((s, d) => s + d.actions.reduce((x, a) => x + a.count, 0), 0),
    days,
  });
  const a1 = actor("savchuk", [
    {
      day: "2026-10-02",
      actions: [{ action: "patient.card_read", count: 1, first: "2026-10-02T07:45:00Z", last: "2026-10-02T07:45:00Z", asUserEmail: null }],
    },
    {
      day: "2026-10-08",
      actions: [
        { action: "response.read", count: 2, first: "2026-10-08T11:20:00Z", last: "2026-10-08T11:31:00Z", asUserEmail: null },
        { action: "patient.card_read", count: 4, first: "2026-10-08T06:12:00Z", last: "2026-10-08T13:52:00Z", asUserEmail: null },
      ],
    },
  ]);
  const a2 = actor("tkach", [
    {
      day: "2026-10-05",
      actions: [{ action: "patient.card_read", count: 3, first: "2026-10-05T12:38:00Z", last: "2026-10-05T12:52:00Z", asUserEmail: "koval@test" }],
    },
  ]);
  const report: WhoViewedReport = {
    patient: { id: "p", fullName: "Мельник Андрій", email: "p@test" },
    from: "2026-09-09",
    to: "2026-10-08",
    total: a1.total + a2.total,
    actors: [a1, a2],
    generatedAt: "2026-10-08T14:00:00Z",
  };

  test("итог: сотрудники, из них «від імені», дни с действиями из дней периода", () => {
    expect(reportSummary(report)).toEqual({ staff: 2, asOther: 1, total: 10, activeDays: 3, periodDays: 30 });
    expect(actorAs(a2)).toEqual(["koval@test"]);
    expect(actorAs(a1)).toEqual([]);
    expect(actorLast(a1)).toBe("2026-10-08T13:52:00Z");
  });

  test("раскладка: свежие дни сверху, внутри дня — по времени; скрытые дни считаются днями", () => {
    const lines = actorLines(a1);
    expect(lines.map((l) => `${l.day} ${l.action}`)).toEqual([
      "2026-10-08 patient.card_read",
      "2026-10-08 response.read",
      "2026-10-02 patient.card_read",
    ]);
    expect(hiddenDays(lines, 1)).toBe(1);
    expect(hiddenDays(lines, 2)).toBe(1);
    expect(hiddenDays(lines, 3)).toBe(0);
  });

  test("готовые периоды: последние N дней включительно, свой период — не готовый", () => {
    const now = new Date(2026, 9, 8, 17);
    expect(presetPeriod("30", now)).toEqual({ from: "2026-09-09", to: "2026-10-08" });
    expect(presetPeriod("7", now)).toEqual({ from: "2026-10-02", to: "2026-10-08" });
    expect(presetOf({ from: "2026-09-09", to: "2026-10-08" }, now)).toBe("30");
    expect(presetOf({ from: "2026-09-10", to: "2026-10-08" }, now)).toBeNull();
    expect(periodOk({ from: "2026-10-08", to: "2026-10-01" })).toBe(false);
    expect(periodOk({ from: "2026-10-01", to: "2026-10-08" })).toBe(true);
    expect(periodDays("2026-10-01", "2026-10-01")).toBe(1);
  });
});

describe("числа словами", () => {
  test("форма по правилу языка: 1 день, 2 дні, 5 днів, 21 день, 11 днів", () => {
    expect([1, 2, 5, 21, 11, 0].map((n) => pluralForm(n, "uk"))).toEqual(["one", "few", "many", "one", "many", "many"]);
    expect([1, 2, 5].map((n) => pluralForm(n, "en"))).toEqual(["one", "many", "many"]);
  });

  test("у каждой семьи чисел — все три формы на трёх языках; у каждого правила — фраза", () => {
    const families = ["opps.n.finding", "opps.n.activeGrant", "opps.n.endingSoon", "opps.n.day", "opps.susp.metaOpen", "opps.who.moreDays"];
    for (const base of families) {
      for (const form of ["one", "few", "many"]) {
        const e = UI[`${base}.${form}` as UiKey];
        expect(e?.uk && e.ru && e.en, `${base}.${form}`).toBeTruthy();
      }
    }
    for (const rule of RULES) expect(UI[`opps.fact.${rule}` as UiKey], rule).toBeDefined();
  });
});
