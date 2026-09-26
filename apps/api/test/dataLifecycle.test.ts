import { describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import {
  api,
  db,
  encryptPersonFields,
  eq,
  groupAdmins,
  makeUser,
  responsesTable,
  root,
  surveyGroups,
  surveys,
  users,
  and,
} from "./fixtures";
import {
  alertCases,
  auditLog,
  batteries,
  batteryAssignments,
  decisionRules,
  episodes,
  invites,
  referrals,
  riskAlerts,
} from "../src/db/schema";
import { DemoPurgeRefused, purgeDemoData } from "../src/lib/demoFill";

/**
 * Жизненный цикл данных вокруг случаев (клиническое ревью волны 12, P2):
 * удаление группы с правилами, уборка вымышленных, закрытие обращения при
 * открытом случае и направлениях.
 *
 * Всё своё — группы, методики, люди с уникальными адресами; открытое
 * закрывается в той же проверке, где заведено.
 */

const tag = crypto.randomUUID().slice(0, 8);

async function group(title: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveyGroups).values({ id, title: `${title} ${tag}`, createdBy: root.id });
  return id;
}

async function survey(groupId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId,
    title: { uk: `Методика ${tag}`, ru: `Методика ${tag}` },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "private",
    createdBy: root.id,
  } as never);
  return id;
}

async function response(surveyId: string, userId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(responsesTable).values({
    id,
    surveyId,
    userId,
    status: "completed",
    startedAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
  } as never);
  return id;
}

async function caseWithSignal(surveyId: string, userId: string): Promise<string> {
  const caseId = crypto.randomUUID();
  const at = new Date().toISOString();
  await db.insert(alertCases).values({ id: caseId, userId, surveyId, severity: "severe", openedAt: at, lastAlertAt: at });
  await db.insert(riskAlerts).values({
    id: crypto.randomUUID(),
    responseId: await response(surveyId, userId),
    surveyId,
    userId,
    caseId,
    label: "Критичний пункт",
    severity: "severe",
    at,
  });
  return caseId;
}

const close = (caseIds: string[]) =>
  db
    .update(alertCases)
    .set({ acknowledgedAt: new Date().toISOString(), acknowledgedBy: root.id, outcome: "not_confirmed" })
    .where(inArray(alertCases.id, caseIds));

describe("удаление группы методик", () => {
  test("группа с правилами не удаляется — её правила не становятся общими для учреждения", async () => {
    const g = await group("Група з правилом");
    const other = await group("Інша група");
    const ruleId = crypto.randomUUID();
    await db.insert(decisionRules).values({
      id: ruleId,
      title: `Правило групи ${tag}`,
      groupId: g,
      // выключенное тоже держит: без группы его включат одной галочкой — уже для всех
      enabled: false,
      conditions: [{ kind: "risk", severity: "severe" }],
      actions: [{ kind: "notify_duty" }],
      createdBy: root.id,
    });

    const refused = await api(`/api/groups/${g}`, root.token, { method: "DELETE" });
    expect(refused.status, "группа с правилом удалилась").toBe(400);
    expect(String(refused.body?.error)).toMatch(/правил/);
    const rule = await db.query.decisionRules.findFirst({ where: eq(decisionRules.id, ruleId) });
    expect(rule?.groupId, "правило группы стало правилом всего учреждения").toBe(g);

    // и из SQL мимо маршрута тоже не удалить — внешний ключ больше не SET NULL
    const direct = await db
      .delete(surveyGroups)
      .where(eq(surveyGroups.id, g))
      .then(() => null)
      .catch((e: unknown) => e);
    expect(direct).not.toBeNull();

    // перенесённое правило группу отпускает
    const moved = await api(`/api/decisions/rules/${ruleId}`, root.token, {
      method: "PATCH",
      body: JSON.stringify({ groupId: other }),
    });
    expect(moved.status).toBe(200);
    expect((await api(`/api/groups/${g}`, root.token, { method: "DELETE" })).status).toBe(204);
  });
});

describe("уборка вымышленных", () => {
  test("прохождения вымышленных уходят из статистики, наборы вымышленного автора — не держат уборку", async () => {
    const g = await group("Демо");
    const s = await survey(g);
    const hash = "x".repeat(60);
    const mk = async (email: string, role: "admin" | "user") => {
      const id = crypto.randomUUID();
      await db.insert(users).values({
        id,
        email,
        ...encryptPersonFields({ firstName: "Демо", lastName: email.split("@")[0]!, birthDate: null }),
        passwordHash: hash,
        role,
      } as never);
      return id;
    };
    const specialist = await mk(`demo-specialist-${tag}@demo.local`, "admin");
    const patients = [await mk(`demo-a-${tag}@demo.local`, "user"), await mk(`demo-b-${tag}@demo.local`, "user")];
    const real = await makeUser("user", `real-${crypto.randomUUID()}@test.dev`);

    // вымышленные прохождения, одно — со случаем риска и сигналом
    const responseIds = [await response(s, patients[0]!), await response(s, patients[1]!)];
    const caseId = await caseWithSignal(s, patients[0]!);

    // то, что наполнение пишет от вымышленного автора
    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({ id: batteryId, title: `Первинний скринінг ${tag}`, groupId: g, createdBy: specialist } as never);
    await db.insert(batteryAssignments).values({ id: crypto.randomUUID(), batteryId, userId: patients[1]!, assignedBy: specialist } as never);
    await db.insert(invites).values({
      id: crypto.randomUUID(),
      tokenHash: crypto.randomUUID(),
      code: tag.toUpperCase(),
      createdBy: specialist,
      note: "без демо-пометки",
      maxUses: 1,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    } as never);
    await db.insert(referrals).values({
      id: crypto.randomUUID(),
      userId: patients[0]!,
      destination: "psychiatrist",
      urgency: "routine",
      status: "created",
      createdBy: specialist,
    } as never);

    /*
     * Набор вымышленного автора назначен настоящему человеку — отказ, и ничего
     * не удалено: снести набор значило бы унести историю назначений живого.
     */
    const held = await db
      .insert(batteryAssignments)
      .values({ id: crypto.randomUUID(), batteryId, userId: real.id, assignedBy: specialist } as never)
      .returning({ id: batteryAssignments.id });
    const refused = await purgeDemoData().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DemoPurgeRefused);
    expect(String((refused as Error).message)).toContain("Первинний скринінг");
    expect(await db.query.users.findFirst({ where: eq(users.id, specialist) })).toBeDefined();
    await db.delete(batteryAssignments).where(eq(batteryAssignments.id, held[0]!.id));

    const removed = await purgeDemoData();
    expect(removed).toBeGreaterThanOrEqual(3);

    const left = await db.select().from(responsesTable).where(inArray(responsesTable.id, responseIds));
    expect(left.length, "вымышленные прохождения остались безымянными в живой статистике").toBe(0);
    expect(await db.query.alertCases.findFirst({ where: eq(alertCases.id, caseId) })).toBeUndefined();
    expect(await db.query.batteries.findFirst({ where: eq(batteries.id, batteryId) })).toBeUndefined();
    expect(await db.query.users.findFirst({ where: eq(users.id, specialist) })).toBeUndefined();
    // настоящий человек не задет
    expect(await db.query.users.findFirst({ where: eq(users.id, real.id) })).toBeDefined();
  });
});

describe("закрытие обращения", () => {
  test("открытый случай риска — отказ без обхода, направления — отказ, снимаемый объяснением в журнал", async () => {
    const g = await group("Звернення");
    const s = await survey(g);
    const foreign = await survey(await group("Чужа зона"));
    const staff = await makeUser("admin", `ep-${crypto.randomUUID()}@test.dev`);
    await db.insert(groupAdmins).values({ groupId: g, userId: staff.id, addedBy: root.id });
    const patient = await makeUser("user", `ep-p-${crypto.randomUUID()}@test.dev`);
    await response(s, patient.id); // человек в зоне сотрудника

    const opened = await api("/api/episodes", staff.token, {
      method: "POST",
      body: JSON.stringify({ patientId: patient.id, reason: "Скарги на сон" }),
    });
    expect(opened.status).toBe(201);
    const episodeId = opened.body.id as string;
    const closeIt = (extra: Record<string, unknown> = {}) =>
      api(`/api/episodes/${episodeId}/close`, staff.token, {
        method: "POST",
        body: JSON.stringify({ outcomeKind: "referred", outcome: "Направлено до психіатра", ...extra }),
      });

    // случай в чужой зоне отказ не называет даже числом
    const foreignCase = await caseWithSignal(foreign, patient.id);
    const ownCase = await caseWithSignal(s, patient.id);

    const blocked = await closeIt({ openReferralsNote: "пояснення не знімає випадку" });
    expect(blocked.status, "обращение закрылось при неразобранном случае риска").toBe(409);
    expect(blocked.body.open).toEqual({ riskCases: 1, referrals: 0 });
    expect(blocked.body.overridable).toBe(false);
    expect((await db.query.episodes.findFirst({ where: eq(episodes.id, episodeId) }))?.closedAt).toBeNull();

    await close([ownCase]);
    await db.insert(referrals).values({
      id: crypto.randomUUID(),
      userId: patient.id,
      destination: "psychiatrist",
      urgency: "routine",
      status: "accepted",
      createdBy: staff.id,
    } as never);

    const referralsOpen = await closeIt();
    expect(referralsOpen.status).toBe(409);
    expect(referralsOpen.body.open).toEqual({ riskCases: 0, referrals: 1 });
    expect(referralsOpen.body.overridable).toBe(true);

    const note = "Людину переведено, направлення закриє сторона, що приймає";
    const done = await closeIt({ openReferralsNote: note });
    expect(done.status).toBe(200);
    const entries = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "episode.close"), eq(auditLog.resourceId, episodeId)));
    // обе попытки-отказа и само закрытие — в журнале; объяснение — у закрытия
    expect(entries.filter((e) => e.outcome === "denied").length).toBe(2);
    const success = entries.find((e) => e.outcome === "success");
    expect(success?.details).toMatchObject({ openReferrals: 1, openReferralsNote: note });

    await close([foreignCase]);
  });
});
