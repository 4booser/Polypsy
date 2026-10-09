import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import type { Page } from "@quizzy/shared";
import { adminA, adminB, api, db, groupA, hashPassword, makeUser, root, surveyInA, users } from "./fixtures";
import { batteries, invites, referrals, surveyAccess } from "../src/db/schema";

/**
 * Списки не отдаются целиком и не теряют строк на границе страницы.
 *
 * Внешний разбор: «списки отдавались целиком» и «обрезанный список
 * направлений выглядел полным: записи после лимита исчезали без
 * предупреждения». Здесь три реестра, которые росли вместе с учреждением и
 * в волне 12 стали страничными: направления, учётные записи, приглашения.
 *
 * Строки каждого набора заводятся ОДНОЙ вставкой — у них одно и то же
 * `now()`, с микросекундами. Это и есть настоящая граница страницы: курсор,
 * собранный из времени, округлённого до миллисекунд, выбрасывал бы всё, что
 * попало в ту же миллисекунду, и список молча кончался бы раньше времени.
 *
 * Таблицы общие на весь прогон, поэтому проверяется не «на странице только
 * мои», а «пролистав до конца, каждого своего видно ровно один раз».
 */

const MANY = 7;
const LIMIT = 3;

/** Обход списка до конца; потолок — защита от курсора, который не двигается */
async function walk<T extends { id: string }>(
  first: string,
  token: string,
  guard = 5000,
): Promise<{ seen: string[]; pages: Page<T>[] }> {
  const seen: string[] = [];
  const pages: Page<T>[] = [];
  let url: string | null = first;
  while (url && pages.length < guard) {
    const res: { status: number; body: Page<T> } = await api<Page<T>>(url, token);
    expect(res.status).toBe(200);
    pages.push(res.body);
    seen.push(...res.body.items.map((i) => i.id));
    const next: string | null = res.body.nextCursor;
    url = next ? `${first}${first.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(next)}` : null;
  }
  expect(url, `список не кончился за ${guard} страниц — курсор не двигается`).toBeNull();
  return { seen, pages };
}

const onceEach = (seen: string[], mine: string[]) => {
  expect(new Set(seen).size, "строка показана на двух страницах").toBe(seen.length);
  for (const id of mine) expect(seen.includes(id), `строка ${id} не попала ни на одну страницу`).toBe(true);
};

describe("направления", () => {
  const mine: string[] = [];

  beforeAll(async () => {
    const person = await makeUser("user", `ref-page-${crypto.randomUUID()}@test`);
    /*
     * Человек — из зоны adminA (назначена методика его группы). Реестр
     * направлений показывает только людей своей зоны (волна 13); прежде он
     * зону не спрашивал вовсе, и тест листал направления человека, которого
     * adminA не видит, — в бою политика строк такие строки прятала.
     */
    await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
    const rows = Array.from({ length: MANY }, () => ({
      id: crypto.randomUUID(),
      userId: person.id,
      destination: "psychiatrist" as const,
      status: "created" as const,
      createdBy: adminA.id,
    }));
    await db.insert(referrals).values(rows);
    mine.push(...rows.map((r) => r.id));
  });

  // направления из «создано» попадают в очередь работы — оставлять их там живыми нельзя
  afterAll(async () => {
    if (mine.length) await db.update(referrals).set({ status: "completed" }).where(inArray(referrals.id, mine));
  });

  test("пролистав до конца, каждое направление видно ровно один раз — и пачка одной вставки не рвётся", async () => {
    const { seen, pages } = await walk<{ id: string }>(`/api/referrals?limit=${LIMIT}`, adminA.token);
    onceEach(seen, mine);
    expect(pages.length).toBeGreaterThan(1);
  }, 60_000);

  test("страница говорит, что она не вся: truncated и курсор совпадают, всего — на первой", async () => {
    const first = await api<Page<{ id: string }>>(`/api/referrals?limit=${LIMIT}`, adminA.token);
    expect(first.body.items.length).toBe(LIMIT);
    expect(first.body.truncated).toBe(true);
    expect(first.body.nextCursor).not.toBeNull();
    expect(first.body.total).toBeGreaterThanOrEqual(MANY);

    const second = await api<Page<{ id: string }>>(
      `/api/referrals?limit=${LIMIT}&cursor=${encodeURIComponent(first.body.nextCursor!)}`,
      adminA.token,
    );
    expect(second.body.total).toBeUndefined();
    expect(second.body.truncated).toBe(second.body.nextCursor !== null);
    const firstIds = new Set(first.body.items.map((r) => r.id));
    expect(second.body.items.filter((r) => firstIds.has(r.id))).toEqual([]);
  });

  test("без параметров — страница по умолчанию, а не весь реестр; потолок страницы держится", async () => {
    const res = await api<Page<{ id: string }>>("/api/referrals", adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(100);
    expect(res.body.truncated).toBe(res.body.nextCursor !== null);
    expect((await api("/api/referrals?limit=500", adminA.token)).status).toBe(400);
  });

  test("испорченный курсор — первая страница, а не пятисотка", async () => {
    const junk = Buffer.from("не-время|x").toString("base64url");
    const res = await api<Page<{ id: string }>>(`/api/referrals?limit=${LIMIT}&cursor=${junk}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(MANY);
  });
});

describe("учётные записи", () => {
  const mine: string[] = [];

  beforeAll(async () => {
    const hash = await hashPassword("secret12345");
    const rows = Array.from({ length: MANY }, (_, i) => ({
      id: crypto.randomUUID(),
      email: `user-page-${i}-${crypto.randomUUID()}@test`,
      firstName: "Сторінка",
      lastName: `Реєстр${i}`,
      passwordHash: hash,
      role: "user" as const,
    }));
    await db.insert(users).values(rows as never);
    mine.push(...rows.map((r) => r.id));
  });

  test("пролистав до конца, каждую учётку видно ровно один раз", async () => {
    const { seen } = await walk<{ id: string }>(`/api/users?limit=${LIMIT}`, root.token);
    onceEach(seen, mine);
  }, 60_000);

  test("без параметров — сотня, а не весь реестр; потолок — пятьсот", async () => {
    const res = await api<Page<{ id: string }>>("/api/users", root.token);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(100);
    expect((await api("/api/users?limit=501", root.token)).status).toBe(400);
  });

  test("?staff=1 — только сотрудники, отбор на сервере", async () => {
    const { seen, pages } = await walk<{ id: string; role: string }>("/api/users?staff=1&limit=50", root.token);
    const everyone = pages.flatMap((p) => p.items);
    expect(everyone.every((u) => u.role !== "user")).toBe(true);
    expect(seen).toContain(adminA.id);
    for (const id of mine) expect(seen).not.toContain(id);
  }, 60_000);
});

describe("приглашения", () => {
  const open: string[] = [];
  const mineB: string[] = [];
  let groupBound = "";

  beforeAll(async () => {
    const battery = crypto.randomUUID();
    await db.insert(batteries).values({ id: battery, title: "Набір групи А", groupId: groupA, createdBy: adminA.id } as never);
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const row = (batteryId: string | null) => ({
      id: crypto.randomUUID(),
      tokenHash: crypto.randomUUID(),
      code: crypto.randomUUID().slice(0, 12),
      createdBy: adminA.id,
      batteryId,
      expiresAt,
    });
    const unbound = Array.from({ length: MANY }, () => row(null));
    const bound = row(battery);
    groupBound = bound.id;
    // свои приглашения adminB вперемешку с чужими: страницы B должны собраться из них
    const ofB = Array.from({ length: 7 }, () => ({ ...row(null), createdBy: adminB.id }));
    const mixed = unbound.flatMap((r, i) => (i % 3 === 0 && ofB[i / 3] ? [r, ofB[i / 3]!] : [r]));
    await db.insert(invites).values([...mixed, ...ofB.filter((b) => !mixed.includes(b)), bound] as never);
    open.push(...unbound.map((r) => r.id));
    mineB.push(...ofB.map((r) => r.id));
  });

  afterAll(async () => {
    const ids = [...open, ...mineB, groupBound].filter(Boolean);
    if (ids.length) await db.update(invites).set({ revokedAt: new Date().toISOString() }).where(inArray(invites.id, ids));
  });

  test("пролистав до конца, каждое приглашение видно ровно один раз", async () => {
    const { seen, pages } = await walk<{ id: string }>(`/api/invites?limit=${LIMIT}`, adminA.token);
    onceEach(seen, [...open, groupBound]);
    expect(pages.length).toBeGreaterThan(1);
  }, 60_000);

  test("страницы собираются из видимых: чужое приглашение не показывается ни на одной", async () => {
    // приглашения без набора — отделения выписавшего (#51): у adminB отделение не adminA
    const { seen } = await walk<{ id: string }>(`/api/invites?limit=${LIMIT}`, adminB.token);
    onceEach(seen, mineB);
    for (const id of [...open, groupBound]) expect(seen).not.toContain(id);
  }, 60_000);

  test("без параметров — сотня, а не всё, что выписано за годы", async () => {
    const res = await api<Page<{ id: string }>>("/api/invites", adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeLessThanOrEqual(100);
    expect((await api("/api/invites?limit=201", adminA.token)).status).toBe(400);
  });
});
