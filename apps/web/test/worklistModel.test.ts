import { describe, expect, test } from "bun:test";
import type { Invite, WorkItem } from "@quizzy/shared";
import { UI } from "@quizzy/shared";
import { inviteCounts, joinedSince, placesLeft, shownInvites } from "../src/pages/invites/model";
import { isWorkView, shownWork, stepWork, workGroups, workKey, workWhy } from "../src/pages/worklist/model";

/**
 * Черга роботи и запрошення (Polypsy 2.0): отбор, группы, порядок, «чому
 * тут» без точки-разделителя, состояния ссылок — без браузера.
 */

const ut = (k: never) => (UI as Record<string, { uk: string }>)[k as string]?.uk ?? String(k);

const item = (over: Partial<WorkItem> & Pick<WorkItem, "kind" | "id">): WorkItem => ({
  userId: `u-${over.id}`,
  userName: `Людина ${over.id}`,
  unit: null,
  title: "PHQ-9",
  overdue: false,
  assignedTo: null,
  since: "2026-10-08T10:00:00.000Z",
  href: "/",
  ...over,
});

describe("черга роботи", () => {
  const items = [
    item({ kind: "message", id: "m1", since: "2026-10-08T09:00:00.000Z", signals: 2, days: 1, overdue: true }),
    item({ kind: "noshow", id: "n1", since: "2026-10-07T09:00:00.000Z", signals: 2, days: 1, unit: "2-й батальйон" }),
    item({ kind: "followup", id: "f1", since: "2026-10-01T09:00:00.000Z", days: 4, overdue: true }),
    item({ kind: "referral", id: "r1", title: "created", destination: "psychiatrist", days: 3 }),
  ];

  test("группы: просроченное сверху, внутри — давнее раньше", () => {
    const g = workGroups(items);
    expect(g.map((x) => x.key)).toEqual(["overdue", "new"]);
    expect(g[0]!.items.map((i) => i.id)).toEqual(["f1", "m1"]);
    expect(g[1]!.items.map((i) => i.id)).toEqual(["n1", "r1"]);
    expect(workGroups([])).toEqual([]);
  });

  test("вид и поиск: просроченное, один вид, имя, подразделение или «чому тут»", () => {
    const why = (i: WorkItem) => workWhy(i, ut);
    expect(shownWork(items, "overdue", "", why).map((i) => i.id)).toEqual(["m1", "f1"]);
    expect(shownWork(items, "noshow", "", why).map((i) => i.id)).toEqual(["n1"]);
    expect(shownWork(items, "", "батальйон", why).map((i) => i.id)).toEqual(["n1"]);
    expect(shownWork(items, "", "психіатр", why).map((i) => i.id)).toEqual(["r1"]);
    expect(isWorkView("noshow")).toBe(true);
    expect(isWorkView("overdue")).toBe(true);
    expect(isWorkView("нет такого")).toBe(false);
  });

  test("название методики — один раз: оно в пилюле строки, «чому тут» его не повторяет", () => {
    const a = item({ kind: "assignment", id: "a1", title: "Входное обследование", days: 3, overdue: true });
    expect(workWhy(a, ut)).toBe("Строк вийшов 3 дн. тому");
    expect(workWhy({ ...a, kind: "followup" }, ut)).toBe("Не зроблено, строк вийшов 3 дн. тому");
    expect(workWhy({ ...a, kind: "followup" }, ut)).not.toContain("Входное");
  });

  test("«чому тут» — фразой через кому, без « · » и без кодов сервера", () => {
    for (const i of items) {
      const text = workWhy(i, ut);
      expect(text).not.toContain(" · ");
      expect(text).not.toMatch(/\bcreated\b|undefined|NaN/);
    }
    expect(workWhy(items[1]!, ut)).toContain("2");
  });

  test("J/K: по списку без круга, с пустого — к краю", () => {
    const keys = items.map(workKey);
    expect(stepWork(keys, null, 1)).toBe("message-m1");
    expect(stepWork(keys, null, -1)).toBe("referral-r1");
    expect(stepWork(keys, "message-m1", -1)).toBe("message-m1");
    expect(stepWork(keys, "noshow-n1", 1)).toBe("followup-f1");
    expect(stepWork(keys, "referral-r1", 1)).toBe("referral-r1");
    expect(stepWork([], "x", 1)).toBeNull();
  });
});

const inv = (over: Partial<Invite> & Pick<Invite, "id">): Invite => ({
  code: `C-${over.id}`,
  batteryId: null,
  batteryTitle: null,
  surveyId: null,
  surveyTitle: null,
  specialistId: null,
  specialistName: null,
  unit: null,
  note: null,
  maxUses: 1,
  usedCount: 0,
  expiresAt: "2026-10-22T00:00:00.000Z",
  revokedAt: null,
  createdAt: "2026-10-08T00:00:00.000Z",
  createdByName: "Савчук Ірина",
  uses: [],
  ...over,
});

describe("запрошення", () => {
  const now = Date.parse("2026-10-08T17:00:00.000Z");
  const rows = [
    inv({ id: "a", unit: "2-й батальйон", maxUses: 30 }),
    inv({ id: "b", maxUses: 24, usedCount: 21 }),
    inv({ id: "c", maxUses: 4, usedCount: 4 }),
    inv({ id: "d", expiresAt: "2026-10-01T00:00:00.000Z" }),
    inv({ id: "e", revokedAt: "2026-09-28T00:00:00.000Z" }),
  ];

  test("счёт по видам сходится со всем списком", () => {
    const c = inviteCounts(rows, now);
    expect(c).toEqual({ live: 2, used: 1, expired: 1, revoked: 1, all: 5 });
    expect(c.live + c.used + c.expired + c.revoked).toBe(c.all);
  });

  test("вид и поиск по коду, подразделению и привязке", () => {
    expect(shownInvites(rows, "live", "", now).map((r) => r.id)).toEqual(["a", "b"]);
    expect(shownInvites(rows, "all", "батальйон", now).map((r) => r.id)).toEqual(["a"]);
    expect(shownInvites(rows, "all", "c-e", now).map((r) => r.id)).toEqual(["e"]);
  });

  test("«лишилось місць» — только у групповой ссылки и только когда осталось три и меньше", () => {
    expect(placesLeft(rows[0]!)).toBeNull();
    expect(placesLeft(rows[1]!)).toBe(3);
    expect(placesLeft(inv({ id: "one" }))).toBeNull();
    expect(placesLeft(rows[2]!)).toBeNull();
  });

  test("вошедшие за 30 дней — по датам входа", () => {
    const withUses = [
      inv({
        id: "x",
        uses: [
          { userId: "1", fullName: "А", usedAt: "2026-10-05T00:00:00.000Z" },
          { userId: "2", fullName: "Б", usedAt: "2026-08-01T00:00:00.000Z" },
        ],
      }),
    ];
    expect(joinedSince(withUses, now)).toBe(1);
  });
});
