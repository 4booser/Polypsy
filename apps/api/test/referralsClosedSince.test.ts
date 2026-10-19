import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { ReferralPage } from "@quizzy/shared";
import { auditLog, referrals, surveyAccess } from "../src/db/schema";
import { adminA, adminB, api, db, makeUser, root, surveyInA, type Person } from "./fixtures";

/**
 * «Закриті за 30 днів» — отбором на сервере (волна 27, perf-day).
 *
 * Реестр направлений идёт по дате выписки, и экран собирал группу «Закриті
 * за 30 днів» из загруженных страниц: давнее направление, закрытое на днях,
 * лежало за ними, и группа его теряла. Теперь у реестра есть ?closedSince= —
 * закрытые (завершены или отклонены) с момента, по времени последнего
 * перехода, с той же зоной и тем же курсором.
 */

const tag = crypto.randomUUID().slice(0, 8);
const day = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * day).toISOString();
const made: string[] = [];
let person: Person;
let oldClosedRecently: string;

async function referral(values: {
  status: "created" | "accepted" | "completed" | "declined";
  createdDaysAgo: number;
  updatedDaysAgo: number | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(referrals).values({
    id,
    userId: person.id,
    destination: "psychiatrist",
    urgency: "routine",
    status: values.status,
    reason: `Перевірка вікна ${tag}`,
    createdBy: adminA.id,
    createdAt: ago(values.createdDaysAgo),
    updatedAt: values.updatedDaysAgo === null ? null : ago(values.updatedDaysAgo),
  } as never);
  made.push(id);
  return id;
}

let expected: Set<string>;
let excluded: Set<string>;

beforeAll(async () => {
  // в зоне adminA — назначением методики группы А
  person = await makeUser("user", `refwin-${tag}@test`);
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });

  // давнее, закрытое позавчера: его группа и теряла
  oldClosedRecently = await referral({ status: "completed", createdDaysAgo: 3000, updatedDaysAgo: 2 });
  const declinedYesterday = await referral({ status: "declined", createdDaysAgo: 5, updatedDaysAgo: 1 });
  // закрыто без перехода (строка без updated_at) — время выписки, как у экрана
  const closedNoTransition = await referral({ status: "completed", createdDaysAgo: 10, updatedDaysAgo: null });
  const closedLongAgo = await referral({ status: "completed", createdDaysAgo: 2900, updatedDaysAgo: 200 });
  const open = await referral({ status: "created", createdDaysAgo: 3, updatedDaysAgo: null });
  const accepted = await referral({ status: "accepted", createdDaysAgo: 4, updatedDaysAgo: 1 });
  // новее давнего — чтобы оно было не на первой странице и при малой выдаче
  for (let i = 0; i < 6; i++) await referral({ status: "completed", createdDaysAgo: 2990 - i, updatedDaysAgo: 2900 });

  expected = new Set([oldClosedRecently, declinedYesterday, closedNoTransition]);
  excluded = new Set([closedLongAgo, open, accepted]);
});

afterAll(async () => {
  // ничего живого в общих очередях: реестр направлений обходит всю базу
  if (made.length) await db.update(referrals).set({ status: "completed" }).where(inArray(referrals.id, made));
});

const since = () => ago(30);

/** Все страницы отбора — курсором, как добирает экран */
async function walk(path: string, who: Person, limit: number): Promise<ReferralPage["items"]> {
  const out: ReferralPage["items"] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 50; i++) {
    const res: { status: number; body: ReferralPage } = await api<ReferralPage>(
      `${path}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      who.token,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    out.push(...res.body.items);
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }
  return out;
}

describe("GET /api/referrals?closedSince=", () => {
  test("закрытые за окно — и давнее, закрытое на днях; открытые и закрытые давно — нет", async () => {
    const items = await walk(`/api/referrals?closedSince=${encodeURIComponent(since())}`, adminA, 100);
    const ids = new Set(items.map((r) => r.id));
    for (const id of expected) expect(ids.has(id), id).toBe(true);
    for (const id of excluded) expect(ids.has(id), id).toBe(false);
    expect(items.every((r) => r.status === "completed" || r.status === "declined")).toBe(true);
    // и ничего, закрытого раньше окна, из всей зоны
    const border = Date.parse(since());
    expect(items.every((r) => Date.parse(r.updatedAt ?? r.createdAt) >= border)).toBe(true);
  });

  test("то, что экран терял: давнего нет на первой странице реестра, а в отборе — есть", async () => {
    const first = await api<ReferralPage>("/api/referrals?all=1&limit=5", root.token);
    expect(first.status).toBe(200);
    expect(first.body.items.some((r) => r.id === oldClosedRecently)).toBe(false);
    const window = await walk(`/api/referrals?closedSince=${encodeURIComponent(since())}`, root, 5);
    expect(window.some((r) => r.id === oldClosedRecently)).toBe(true);
  });

  test("курсор отбора: страницами по одной — те же строки и тот же порядок", async () => {
    const path = `/api/referrals?closedSince=${encodeURIComponent(since())}`;
    const whole = await walk(path, adminA, 100);
    const paged = await walk(path, adminA, 1);
    expect(paged.map((r) => r.id)).toEqual(whole.map((r) => r.id));
    const at = whole.map((r) => r.createdAt);
    expect([...at].sort().reverse()).toEqual(at);
    /*
     * Свой срок, а не пять секунд по умолчанию: обход по одной строке — это
     * запрос на каждое закрытое направление зоны, а под ролью приложения в
     * CI каждый шёл по полсекунды (политика строк считает зону на строке, и
     * на свежей базе без статистики план хуже). Проверка — о порядке и
     * полноте страниц, не о скорости.
     */
  }, 30_000);

  test("зона — та же: чужая группа своих людей в отборе не видит", async () => {
    const items = await walk(`/api/referrals?closedSince=${encodeURIComponent(since())}`, adminB, 100);
    expect(items.some((r) => r.userId === person.id)).toBe(false);
  });

  test("число по статусам — по всей зоне, total — по отбору", async () => {
    const res = await api<ReferralPage>(`/api/referrals?closedSince=${encodeURIComponent(since())}`, adminA.token);
    expect(res.status).toBe(200);
    const all = await api<ReferralPage>("/api/referrals?all=1", adminA.token);
    expect(res.body.counts).toEqual(all.body.counts);
    expect(res.body.total).toBeLessThanOrEqual(all.body.total!);
    expect(res.body.total).toBeGreaterThanOrEqual(expected.size);
  });

  test("кривой момент — 400, а не пятисотка; пустой — как без отбора", async () => {
    expect((await api("/api/referrals?closedSince=%D0%B2%D1%87%D0%BE%D1%80%D0%B0", adminA.token)).status).toBe(400);
    expect((await api("/api/referrals?closedSince=2026-02-31", adminA.token)).status).toBe(400);
    const blank = await api<ReferralPage>("/api/referrals?closedSince=&all=1&limit=1", adminA.token);
    expect(blank.status).toBe(200);
  });

  test("чтение — в журнал, с окном", async () => {
    const at = since();
    expect((await api(`/api/referrals?closedSince=${encodeURIComponent(at)}`, adminA.token)).status).toBe(200);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, adminA.id), eq(auditLog.action, "referral.list")))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect((row!.details as { closedSince?: string }).closedSince).toBe(at);
  });
});
