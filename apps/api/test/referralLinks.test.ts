import { afterAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { adminA, adminB, api, db, eq, makeUser, submitSurvey, surveyInA, surveyInB, type Person } from "./fixtures";
import { decisionRules, referrals, riskAlerts, ruleHits, surveyAccess } from "../src/db/schema";

/**
 * Ссылки направления — на записи того же пациента (волна 16, внешний разбор, P2).
 *
 * POST /referrals проверял пациента и доступ к нему, а responseId и alertId
 * переносил в строку как есть: направление пациента A заводилось с
 * прохождением и тревогой пациента B — из чужой группы методик, недоступных
 * сотруднику даже на чтение (GET /responses/:id отвечал 404). Внешние ключи
 * подтверждают, что записи существуют, и ничего — о том, чьи они.
 *
 * Правило теперь одно (lib/clinicalRead.ts, assertReferralLinks): каждая
 * ссылка — доступна сотруднику той же проверкой, что открывает её саму;
 * принадлежит тому же пациенту; тревога — от указанного прохождения, если
 * названы обе. Файл — в списке test:app-role: ссылки — клинические данные
 * пациента, и под политиками строк чужое прохождение к тому же невидимо.
 */

const tag = () => crypto.randomUUID().slice(0, 8);

const made: string[] = [];

afterAll(async () => {
  // ничего живого в общих очередях: реестр направлений обходит всю базу
  if (made.length) await db.update(referrals).set({ status: "completed" }).where(inArray(referrals.id, made));
});

/** Пациент в зоне adminA — назначением методики группы А */
async function patientOfA(name: string): Promise<Person> {
  const person = await makeUser("user", `rl-${name}-${tag()}@test`, { sex: "male", birthDate: "1990-01-01" });
  await db.insert(surveyAccess).values({ surveyId: surveyInA, userId: person.id, grantedBy: adminA.id });
  return person;
}

/** Сдача методики и тревога по ней — тревога заводится прямо, чтобы не зависеть от ключа риска */
async function responseWithAlert(person: Person, surveyId: string) {
  const res = await submitSurvey(surveyId, person.token);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const alertId = crypto.randomUUID();
  await db.insert(riskAlerts).values({
    id: alertId,
    responseId: res.body.id,
    surveyId,
    userId: person.id,
    label: "Синтетична тривога",
    severity: "moderate",
    at: new Date().toISOString(),
  } as never);
  return { responseId: res.body.id as string, alertId };
}

function refer(body: Record<string, unknown>, token = adminA.token) {
  return api("/api/referrals", token, {
    method: "POST",
    body: JSON.stringify({ destination: "psychiatrist", urgency: "routine", reason: "Перевірка посилань", ...body }),
  });
}

describe("направление: прохождение и тревога — того же пациента", () => {
  test("ровно сценарий ревьюера: пациент A, записи пациента B из чужой группы — 404, направления нет", async () => {
    const a = await patientOfA("a");
    // пациент B — в группе Б: его прохождение сотруднику группы А не открыть
    const b = await makeUser("user", `rl-b-${tag()}@test`, { sex: "female", birthDate: "1991-01-01" });
    await db.insert(surveyAccess).values({ surveyId: surveyInB, userId: b.id, grantedBy: adminB.id });
    const foreign = await responseWithAlert(b, surveyInB);
    expect((await api(`/api/responses/${foreign.responseId}`, adminA.token)).status).toBe(404);

    const res = await refer({ userId: a.id, responseId: foreign.responseId, alertId: foreign.alertId });
    expect(res.status, JSON.stringify(res.body)).toBe(404);

    const rows = await db.select({ id: referrals.id }).from(referrals).where(eq(referrals.userId, a.id));
    expect(rows, "направление пациента A ссылается на записи пациента B").toEqual([]);
  });

  test("прохождение доступно, но другого пациента — 400 с причиной", async () => {
    const a = await patientOfA("a2");
    const b = await patientOfA("b2");
    const own = await responseWithAlert(b, surveyInA);

    const byResponse = await refer({ userId: a.id, responseId: own.responseId });
    expect(byResponse.status).toBe(400);
    expect(byResponse.body.error).toContain("іншому пацієнту");

    const byAlert = await refer({ userId: a.id, alertId: own.alertId });
    expect(byAlert.status).toBe(400);
    expect(byAlert.body.error).toContain("іншого пацієнта");
  });

  test("тревога от другого прохождения того же пациента — 400", async () => {
    const a = await patientOfA("a3");
    const first = await responseWithAlert(a, surveyInA);
    const second = await responseWithAlert(a, surveyInA);

    const res = await refer({ userId: a.id, responseId: first.responseId, alertId: second.alertId });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("іншого проходження");
  });

  test("несуществующие ссылки — 404, а не пятисотка внешнего ключа", async () => {
    const a = await patientOfA("a4");
    expect((await refer({ userId: a.id, responseId: crypto.randomUUID() })).status).toBe(404);
    expect((await refer({ userId: a.id, alertId: crypto.randomUUID() })).status).toBe(404);
  });

  test("свои записи того же пациента — 201, ссылки на месте", async () => {
    const a = await patientOfA("a5");
    const own = await responseWithAlert(a, surveyInA);
    const res = await refer({ userId: a.id, responseId: own.responseId, alertId: own.alertId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    made.push(res.body.id);
    expect(res.body.responseId).toBe(own.responseId);
    expect(res.body.alertId).toBe(own.alertId);

    // и без ссылок — как прежде
    const bare = await refer({ userId: a.id });
    expect(bare.status).toBe(201);
    made.push(bare.body.id);
  });
});

/* ─────────── тот же проход по остальным маршрутам: решение по срабатыванию правила ─────────── */

describe("решение по срабатыванию правила — только в своей зоне", () => {
  test("срабатывание в чужой группе методик для adminA не существует", async () => {
    /*
     * PATCH /decisions/hits/:id находил срабатывание по id и записывал решение,
     * не спрашивая зону: в бою это закрывала политика строк, владельцем —
     * ничего. Чужого пациента сюда не подставить (пациент и методика берутся
     * из самого срабатывания), но решение по сигналу чужой группы — та же
     * дыра «проверяется вход, а не связь».
     */
    const b = await makeUser("user", `rl-hit-${tag()}@test`, { sex: "male", birthDate: "1990-01-01" });
    await db.insert(surveyAccess).values({ surveyId: surveyInB, userId: b.id, grantedBy: adminB.id });
    const res = await submitSurvey(surveyInB, b.token);
    expect(res.status).toBe(201);

    const ruleId = crypto.randomUUID();
    await db.insert(decisionRules).values({
      id: ruleId,
      title: `Правило ${tag()}`,
      enabled: true,
      conditions: [],
      actions: [],
      createdBy: adminB.id,
    } as never);
    const hitId = crypto.randomUUID();
    await db.insert(ruleHits).values({
      id: hitId,
      ruleId,
      ruleVersion: 1,
      responseId: res.body.id,
      userId: b.id,
      surveyId: surveyInB,
      explanation: { kind: "codes", codes: [] },
    } as never);

    const foreign = await api(`/api/decisions/hits/${hitId}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "accepted" }),
    });
    expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
    const [row] = await db.select({ status: ruleHits.status }).from(ruleHits).where(eq(ruleHits.id, hitId));
    expect(row!.status).toBe("suggested");

    const own = await api(`/api/decisions/hits/${hitId}`, adminB.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "accepted" }),
    });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
  });
});
