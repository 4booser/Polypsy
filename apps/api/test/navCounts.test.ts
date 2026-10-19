import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AlertCaseCount, AlertCasePage, ReferralCount, ReferralPage, Worklist, WorklistCount } from "@quizzy/shared";
import { alertCases, auditLog, batteries, batteryAssignments, permissionExceptions, referrals, surveyAccess } from "../src/db/schema";
import { requestSql } from "../src/lib/opsSql";
import { adminA, adminB, api, db, makeUser, root, surveyInA, surveyInB, type Person } from "./fixtures";

/**
 * Числа рельсы — маршрутами чисел (волна 27, perf-day2).
 *
 * Бейджи «Черга», «Випадки ризику» и «Направлення» опрашивали раз в минуту
 * первые страницы своих списков: с расшифрованными именами людей, с
 * поводами направлений и со строкой журнала (worklist.read, alert.list,
 * referral.list) на каждый такт. Теперь у каждого свой /count: те же числа в
 * той же зоне, без людей и без строки журнала.
 *
 * Сверка — с самими списками, от разных людей: сотрудник группы А (своя
 * зона), сотрудник группы Б (чужая), суперадмин (все). Данные — свои люди в
 * обеих зонах с направлениями всех статусов, неразобранными и разобранными
 * случаями и просроченным назначением; остальное — что лежит в базе от
 * соседних файлов, оно сверяется теми же списками.
 */

const tag = crypto.randomUUID().slice(0, 8);
let inA: Person;
let inB: Person;
let nobody: Person;
const made = { referrals: [] as string[], cases: [] as string[], assignments: [] as string[] };
let batteryId: string;

async function referral(userId: string, status: "created" | "accepted" | "completed" | "declined") {
  const id = crypto.randomUUID();
  await db.insert(referrals).values({
    id,
    userId,
    destination: "psychiatrist",
    urgency: "routine",
    status,
    reason: `Числа рельсы ${tag}`,
    createdBy: adminA.id,
  } as never);
  made.referrals.push(id);
}

async function openCase(userId: string, surveyId: string) {
  const id = crypto.randomUUID();
  await db.insert(alertCases).values({ id, userId, surveyId, severity: "severe" });
  made.cases.push(id);
}

beforeAll(async () => {
  inA = await makeUser("user", `navc-a-${tag}@test`);
  inB = await makeUser("user", `navc-b-${tag}@test`);
  // в зоне групп — назначением их методик
  await db.insert(surveyAccess).values([
    { surveyId: surveyInA, userId: inA.id, grantedBy: adminA.id },
    { surveyId: surveyInB, userId: inB.id, grantedBy: adminB.id },
  ]);
  for (const status of ["created", "accepted", "declined", "completed"] as const) await referral(inA.id, status);
  await referral(inB.id, "created");
  await referral(inB.id, "declined");
  // два неразобранных случая одного человека — одна строка очереди по людям
  await openCase(inA.id, surveyInA);
  await openCase(inA.id, surveyInA);
  await openCase(inB.id, surveyInB);
  // просроченное назначение набора — вид «assignment» очереди работы
  batteryId = crypto.randomUUID();
  await db.insert(batteries).values({ id: batteryId, title: `Набір ${tag}`, groupId: null, createdBy: adminA.id } as never);
  const assignment = crypto.randomUUID();
  await db.insert(batteryAssignments).values({
    id: assignment,
    batteryId,
    userId: inA.id,
    assignedBy: adminA.id,
    assignedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  } as never);
  made.assignments.push(assignment);
  // сотрудник без прав на очереди: каждый такт был бы отказом
  nobody = await makeUser("admin", `navc-none-${tag}@test`);
  for (const permission of ["referrals.manage", "alerts.review", "patients.read"]) {
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: nobody.id,
      permission,
      mode: "revoke",
      reason: "Проверка чисел рельсы без права",
      grantedBy: root.id,
    } as never);
  }
});

afterAll(async () => {
  // ничего живого в общих очередях: их обходят соседние файлы
  const now = new Date().toISOString();
  if (made.referrals.length) await db.update(referrals).set({ status: "completed" }).where(inArray(referrals.id, made.referrals));
  if (made.cases.length) await db.update(alertCases).set({ acknowledgedAt: now }).where(inArray(alertCases.id, made.cases));
  if (made.assignments.length) {
    await db.update(batteryAssignments).set({ cancelledAt: now } as never).where(inArray(batteryAssignments.id, made.assignments));
  }
  await db.update(batteries).set({ archived: true } as never).where(eq(batteries.id, batteryId));
});

/** Ответ и счёт SQL запроса */
async function counted<T>(path: string, who: Person): Promise<{ status: number; body: T; sql: number }> {
  const requestId = crypto.randomUUID();
  const res = await api<T>(path, who.token, { headers: { "x-request-id": requestId } });
  return { status: res.status, body: res.body, sql: requestSql(requestId)?.count ?? 0 };
}

const auditRows = async (actor: string, action: string) =>
  Number(
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(and(eq(auditLog.actorId, actor), eq(auditLog.action, action)))
    )[0]?.n ?? 0,
  );

const PEOPLE = () =>
  [
    ["сотрудник группы А", adminA],
    ["сотрудник группы Б", adminB],
    ["суперадмин", root],
  ] as const;

describe("GET /api/referrals/count", () => {
  test("total — ровно total реестра без ?all=1, open — виписані и прийняті по числам реестра", async () => {
    for (const [who, person] of PEOPLE()) {
      const count = await api<ReferralCount>("/api/referrals/count", person.token);
      expect(count.status, who).toBe(200);
      const list = await api<ReferralPage>("/api/referrals", person.token);
      expect(list.status, who).toBe(200);
      expect(count.body.total, who).toBe(list.body.total!);
      expect(count.body.open, who).toBe(list.body.counts!.created + list.body.counts!.accepted);
    }
  });

  test("зона: своё направление считается, чужое — нет", async () => {
    const a = (await api<ReferralCount>("/api/referrals/count", adminA.token)).body;
    // временно закрыть одно своё — число адмiна А уменьшится, у Б — нет
    const b = (await api<ReferralCount>("/api/referrals/count", adminB.token)).body;
    const [own] = await db
      .select({ id: referrals.id })
      .from(referrals)
      .where(and(eq(referrals.userId, inA.id), eq(referrals.status, "created")));
    await db.update(referrals).set({ status: "completed" }).where(eq(referrals.id, own!.id));
    try {
      expect((await api<ReferralCount>("/api/referrals/count", adminA.token)).body).toEqual({ total: a.total - 1, open: a.open - 1 });
      expect((await api<ReferralCount>("/api/referrals/count", adminB.token)).body).toEqual(b);
    } finally {
      await db.update(referrals).set({ status: "created" }).where(eq(referrals.id, own!.id));
    }
  });
});

describe("GET /api/worklist/count", () => {
  test("те же total, byKind и mine, что у очереди", async () => {
    for (const [who, person] of PEOPLE()) {
      const count = await api<WorklistCount>("/api/worklist/count", person.token);
      expect(count.status, who).toBe(200);
      const list = await api<Worklist>("/api/worklist", person.token);
      expect(list.status, who).toBe(200);
      expect(count.body, who).toEqual({ total: list.body.total, byKind: list.body.byKind, mine: list.body.mine });
    }
    // и смысл: свои направления и просроченное назначение — в очереди сотрудника группы А
    const own = (await api<WorklistCount>("/api/worklist/count", adminA.token)).body;
    expect(own.byKind.referral).toBeGreaterThanOrEqual(2);
    expect(own.byKind.assignment).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/alert-cases/count", () => {
  test("людей с неразобранными случаями — ровно total открытой очереди по людям", async () => {
    for (const [who, person] of PEOPLE()) {
      const count = await api<AlertCaseCount>("/api/alert-cases/count", person.token);
      expect(count.status, who).toBe(200);
      const list = await api<AlertCasePage>("/api/alert-cases?limit=1", person.token);
      expect(list.status, who).toBe(200);
      expect(count.body.total, who).toBe(list.body.total!);
    }
  });

  test("человек, а не случай: второй случай того же человека числа не меняет", async () => {
    const before = (await api<AlertCaseCount>("/api/alert-cases/count", adminA.token)).body.total;
    await openCase(inA.id, surveyInA);
    expect((await api<AlertCaseCount>("/api/alert-cases/count", adminA.token)).body.total).toBe(before);
  });
});

describe("числа рельсы: без людей, без журнала, тот же заслон", () => {
  test("в ответах только числа", async () => {
    const r = await api<ReferralCount>("/api/referrals/count", adminA.token);
    const w = await api<WorklistCount>("/api/worklist/count", adminA.token);
    const a = await api<AlertCaseCount>("/api/alert-cases/count", adminA.token);
    expect(Object.keys(r.body).sort()).toEqual(["open", "total"]);
    expect(Object.keys(w.body).sort()).toEqual(["byKind", "mine", "total"]);
    expect(Object.keys(a.body)).toEqual(["total"]);
    for (const body of [r.body, w.body, a.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(`navc-a-${tag}`);
      expect(text).not.toContain("Числа рельсы");
    }
  });

  test("опрос чисел не пишет в журнал; просмотр списков — пишет, как прежде", async () => {
    const actions = ["referral.list", "worklist.read", "alert.list"] as const;
    const before = await Promise.all(actions.map((a) => auditRows(adminA.id, a)));
    for (let i = 0; i < 3; i++) {
      expect((await api("/api/referrals/count", adminA.token)).status).toBe(200);
      expect((await api("/api/worklist/count", adminA.token)).status).toBe(200);
      expect((await api("/api/alert-cases/count", adminA.token)).status).toBe(200);
    }
    expect(await Promise.all(actions.map((a) => auditRows(adminA.id, a)))).toEqual(before);

    await api("/api/referrals", adminA.token);
    await api("/api/worklist", adminA.token);
    await api("/api/alert-cases?limit=1", adminA.token);
    expect(await Promise.all(actions.map((a) => auditRows(adminA.id, a)))).toEqual(before.map((n) => n + 1));
  });

  test("тот же заслон, что у списков: без права и пациенту — отказ", async () => {
    for (const path of ["/api/referrals/count", "/api/worklist/count", "/api/alert-cases/count"]) {
      expect((await api(path, nobody.token)).status, path).toBe(403);
      expect((await api(path, inA.token)).status, path).toBe(403);
    }
  });

  /* порядок величин: число дешевле страницы списка, и счёт SQL направлений не растёт со строками */
  test("числа дешевле списков", async () => {
    for (const [count, list] of [
      ["/api/referrals/count", "/api/referrals"],
      ["/api/alert-cases/count", "/api/alert-cases?limit=1"],
      ["/api/worklist/count", "/api/worklist"],
    ] as const) {
      const c = await counted(count, adminA);
      const l = await counted(list, adminA);
      expect(c.sql, count).toBeGreaterThan(0);
      expect(c.sql, count).toBeLessThan(l.sql);
    }
  });
});
