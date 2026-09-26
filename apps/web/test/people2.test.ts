import { describe, expect, test } from "bun:test";
import { UI, type SuspiciousFinding, type SuspiciousThresholds, type UiKey, type WhoViewedReport } from "@quizzy/shared";
import {
  IMPORT_HEADER,
  RULES,
  csvCell,
  defaultPeriod,
  findingFacts,
  importErrorKey,
  importTemplateCsv,
  journalLink,
  pageSelection,
  passwordsCsv,
  ruleExplanation,
  ruleKey,
  skipKey,
  skippedByReason,
  timeLeft,
  toggleId,
  whoViewedCsv,
  withPage,
} from "../src/pages/ops/people2/model";
import { activeSlot } from "../src/api";

/**
 * «Люди й безпека» без браузера: выбор строк, итог пачки, CSV, пояснения
 * правил и ссылки в журнал.
 *
 * Главное здесь — то, что на экране выглядит правильно и при этом врёт:
 * «вибрати всіх на сторінці», стирающее выбор на соседней странице; CSV,
 * который табличный редактор выполнит как формулу; пояснение правила с
 * числом, разошедшимся с сервером.
 */

const ut = (key: UiKey) => UI[key].uk;

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
  timezone: "Europe/Kyiv",
  hoursSource: "schedule",
};

function finding(partial: Partial<SuspiciousFinding> & Pick<SuspiciousFinding, "rule">): SuspiciousFinding {
  return {
    id: "f1",
    actorId: "u1",
    actorEmail: "doc@test",
    actorName: "Лікар",
    subjectId: null,
    subjectName: null,
    ip: null,
    windowFrom: "2026-09-24T22:10:00.000Z",
    windowTo: "2026-09-25T00:40:00.000Z",
    hits: 5,
    details: null,
    detectedAt: "2026-09-25T00:45:00.000Z",
    notified: false,
    resolvedAt: null,
    resolvedByEmail: null,
    resolution: null,
    ...partial,
  };
}

describe("выбор строк", () => {
  test("страница отмечается и снимается, не трогая выбранных на других страницах", () => {
    const other = new Set(["x"]);
    const on = withPage(other, ["a", "b"], true);
    expect([...on].sort()).toEqual(["a", "b", "x"]);
    expect(pageSelection(on, ["a", "b"])).toBe("all");
    const off = withPage(on, ["a", "b"], false);
    expect([...off]).toEqual(["x"]);
    expect(pageSelection(toggleId(off, "a"), ["a", "b"])).toBe("some");
    expect(pageSelection(new Set(), [])).toBe("none");
  });
});

describe("итог пачки", () => {
  test("пропущенные — по причинам, чаще встречающиеся сверху, у каждой причины есть слово", () => {
    const groups = skippedByReason({
      action: "disable",
      done: [{ id: "1", email: "a@t" }],
      skipped: [
        { id: "2", email: "b@t", reason: "alreadyDisabled" },
        { id: "3", email: "c@t", reason: "self" },
        { id: "4", email: null, reason: "alreadyDisabled" },
      ],
    });
    expect(groups.map((g) => [g.reason, g.count])).toEqual([
      ["alreadyDisabled", 2],
      ["self", 1],
    ]);
    // почты нет (учётка не найдена) — идентификатор, а не пустая строка
    expect(groups[0]!.emails).toEqual(["b@t", "4"]);
    for (const r of ["notFound", "self", "superadminOnly", "lastSuperadmin", "alreadyDisabled", "notDisabled", "patient", "superadminTarget", "alreadyHasRole", "roleNotInChain", "roleAboveYours", "roleGrantsMore"] as const) {
      expect(UI[skipKey(r)], r).toBeDefined();
    }
  });
});

describe("CSV", () => {
  test("формула не выполняется, кавычки и разделители экранируются", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+380")).toBe("'+380");
    expect(csvCell('Коваль; "старший"')).toBe('"Коваль; ""старший"""');
    expect(csvCell(null)).toBe("");
  });

  test("шаблон импорта — те колонки, что понимает сервер, и образец строки", () => {
    const csv = importTemplateCsv();
    expect(csv.startsWith("\uFEFF")).toBe(true);
    const [head, sample] = csv.slice(1).trim().split("\r\n");
    expect(head!.split(",")).toEqual([...IMPORT_HEADER]);
    expect(sample!.split(",")).toHaveLength(IMPORT_HEADER.length);
  });

  test("пароли — строка на человека", () => {
    const csv = passwordsCsv([{ id: "1", email: "a@t", fullName: "Коваленко Олена", role: "admin", password: "abcd-efgh-jkmn-pqrs" }], ["ПІБ", "Пошта", "Пароль"]);
    expect(csv).toContain("Коваленко Олена,a@t,abcd-efgh-jkmn-pqrs");
  });

  test("отчёт «хто переглядав» — действия словами, «від імені» отдельной колонкой", () => {
    const report: WhoViewedReport = {
      patient: { id: "p", fullName: "Пацієнт", email: "p@t" },
      from: "2026-09-01",
      to: "2026-09-30",
      total: 3,
      generatedAt: "2026-09-26T10:00:00.000Z",
      actors: [
        {
          actorId: "d",
          actorEmail: "d@t",
          actorName: "Лікар",
          actorRole: "admin",
          total: 3,
          days: [
            {
              day: "2026-09-24",
              actions: [
                { action: "patient.card_read", count: 2, first: "2026-09-24T09:00:00.000Z", last: "2026-09-24T10:00:00.000Z", asUserEmail: null },
                { action: "response.read", count: 1, first: "2026-09-24T11:00:00.000Z", last: "2026-09-24T11:00:00.000Z", asUserEmail: "x@t" },
              ],
            },
          ],
        },
      ],
    };
    const lines = whoViewedCsv(report, (a) => (a === "patient.card_read" ? "Перегляд картки" : a), ["a", "b", "c", "d", "e", "f", "g", "h", "i"])
      .slice(1)
      .trim()
      .split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("Перегляд картки,2");
    expect(lines[2]!.endsWith(",x@t")).toBe(true);
  });

  test("у каждой ошибки строки импорта есть слово", () => {
    for (const e of ["lastNameRequired", "firstNameRequired", "emailRequired", "emailInvalid", "emailTaken", "emailDuplicate", "roleUnknown", "roleNotAllowed", "roleTemplateUnknown", "roleTemplateAboveYours"] as const) {
      expect(UI[importErrorKey(e)], e).toBeDefined();
    }
  });
});

describe("подозрительная активность", () => {
  test("у каждого правила есть имя и пояснение; числа — с сервера, без незаполненных скобок", () => {
    for (const r of RULES) {
      expect(UI[ruleKey(r)], r).toBeDefined();
      const text = ruleExplanation(r, TH, ut);
      expect(text, r).not.toMatch(/\{\w+\}/);
    }
    expect(ruleExplanation("massReads", TH, ut)).toContain("25");
    expect(ruleExplanation("nightActivity", TH, ut)).toContain("21:00");
    expect(ruleExplanation("nightActivity", TH, ut)).toContain(UI["ops.susp.hoursSchedule"].uk);
  });

  test("ссылка в журнал: по почте для неудачных входов, по сессии для «від імені», дни включительно", () => {
    const failed = new URL(journalLink(finding({ rule: "failedLoginsAccount", actorId: null })), "http://x");
    expect(failed.pathname).toBe("/ops/audit");
    expect(failed.searchParams.get("action")).toBe("auth.login_failed");
    expect(failed.searchParams.get("q")).toBe("doc@test");
    // серия через полночь — оба дня
    expect(failed.searchParams.get("from")).toBe("2026-09-24");
    expect(failed.searchParams.get("to")).toBe("2026-09-25");

    const imp = new URL(journalLink(finding({ rule: "impersonation", details: { session: "s-1" } })), "http://x");
    expect(imp.searchParams.get("actor")).toBe("u1");
    expect(imp.searchParams.get("q")).toBe("s-1");
  });

  test("что случилось — числом и словами правила", () => {
    expect(findingFacts(finding({ rule: "failedLoginsIp", hits: 12, ip: "10.0.0.1", details: { accounts: 4 } }), ut)).toBe(
      `12 ${UI["ops.susp.events"].uk} · 4 ${UI["ops.susp.accounts"].uk} · 10.0.0.1`,
    );
    expect(findingFacts(finding({ rule: "impersonation", details: { reason: "скарга" } }), ut)).toContain("скарга");
  });
});

describe("сроки и периоды", () => {
  test("осталось: днями, в последние сутки — часами, прошедшее — ничего", () => {
    const now = Date.parse("2026-09-26T10:00:00.000Z");
    expect(timeLeft("2026-09-29T10:00:00.000Z", now)).toEqual({ unit: "days", n: 3 });
    expect(timeLeft("2026-09-26T12:30:00.000Z", now)).toEqual({ unit: "hours", n: 3 });
    expect(timeLeft("2026-09-26T09:00:00.000Z", now)).toBeNull();
  });

  test("период по умолчанию — тридцать дней, сегодня включительно", () => {
    expect(defaultPeriod(new Date(2026, 8, 26, 15))).toEqual({ from: "2026-08-28", to: "2026-09-26" });
  });

  test("токен «от имени» с истёкшим сроком не используется", () => {
    const now = Date.parse("2026-09-26T10:00:00.000Z");
    expect(activeSlot({ token: "t", sessionId: "s", expiresAt: "2026-09-26T10:30:00.000Z" }, now)).toBe(true);
    expect(activeSlot({ token: "t", sessionId: "s", expiresAt: "2026-09-26T09:59:00.000Z" }, now)).toBe(false);
    expect(activeSlot(null, now)).toBe(false);
  });
});

test("подписи новых разделов техпанели есть в словаре на трёх языках", () => {
  for (const key of ["ops.tab.suspicious", "ops.tab.grants", "ops.tab.whoViewed", "ops.tab.mfa", "ops.imp.banner", "lg.mfa.title"] as UiKey[]) {
    expect(UI[key].uk && UI[key].ru && UI[key].en, key).toBeTruthy();
  }
});
