import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Интеграционные тесты API против отдельной базы `<имя>_test`.
 *
 * База настраивается ДО импорта приложения: модуль db читает DATABASE_URL при
 * загрузке, поэтому все импорты ниже — динамические. Правило имени жёсткое:
 * тесты никогда не ходят в рабочую базу.
 */
const baseUrl = process.env.DATABASE_URL ?? "postgres://abooser@localhost:5432/quizzy";
const parsed = new URL(baseUrl);
const baseName = parsed.pathname.slice(1);
const testName = baseName.endsWith("_test") ? baseName : `${baseName}_test`;
parsed.pathname = `/${testName}`;
process.env.DATABASE_URL = parsed.toString();
process.env.SCHEDULER_ENABLED = "0";

// пересоздаём тестовую базу через служебное подключение к рабочей
{
  const postgres = (await import("postgres")).default;
  const admin = postgres(baseUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testName}`);
  await admin.unsafe(`CREATE DATABASE ${testName}`);
  await admin.end();
}

const { app } = await import("../src/app");
const { db, client } = await import("../src/db");
const { users, surveyGroups, groupAdmins, batteries, batteryItems, schedules, scheduleRuns, batteryAssignments } =
  await import("../src/db/schema");
const { hashPassword, issueToken } = await import("../src/lib/auth");
const { createVersion } = await import("../src/lib/surveys");
const { runDueSchedules } = await import("../src/lib/scheduler");
const { surveys } = await import("../src/db/schema");
const { createSurveySchema } = await import("@quizzy/shared");
const { sr45 } = await import("../src/instruments/sr45");
const { migrate } = await import("drizzle-orm/postgres-js/migrator");
const { eq, and, isNull } = await import("drizzle-orm");

/* ── фикстуры ── */

interface Person {
  id: string;
  token: string;
}

async function makeUser(role: "superadmin" | "admin" | "user", email: string, extra: Record<string, unknown> = {}): Promise<Person> {
  const id = crypto.randomUUID();
  await db.insert(users).values({
    id,
    email,
    firstName: "Тест",
    lastName: email.split("@")[0]!,
    passwordHash: await hashPassword("secret12345"),
    role,
    ...extra,
  } as never);
  return { id, token: await issueToken({ id, role }) };
}

async function api(path: string, token: string, init: RequestInit = {}) {
  const res = await app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

let root: Person;
let adminA: Person;
let adminB: Person;
let patient: Person;
let groupA: string;
let groupB: string;
let surveyInA: string;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });

  root = await makeUser("superadmin", "root@test");
  adminA = await makeUser("admin", "a@test");
  adminB = await makeUser("admin", "b@test");
  patient = await makeUser("user", "p@test", { sex: "male", birthDate: "1990-01-01", unit: "Рота А" });

  groupA = crypto.randomUUID();
  groupB = crypto.randomUUID();
  await db.insert(surveyGroups).values([
    { id: groupA, title: "Группа А", createdBy: root.id },
    { id: groupB, title: "Группа Б", createdBy: root.id },
  ]);
  await db.insert(groupAdmins).values([
    { groupId: groupA, userId: adminA.id, assignedBy: root.id },
    { groupId: groupB, userId: adminB.id, assignedBy: root.id },
  ]);

  // методика в группе А — через реальный конвейер посева
  const input = createSurveySchema.parse(sr45);
  surveyInA = crypto.randomUUID();
  await db.insert(surveys).values({
    id: surveyInA,
    groupId: groupA,
    title: input.title,
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(surveyInA, input, adminA.id, "Тестовая версия");
});

afterAll(async () => {
  await client.end({ timeout: 3 }).catch(() => {});
});

/* ── скоупинг ── */

describe("скоупинг групп", () => {
  test("админ чужой группы получает отказ на методику группы А", async () => {
    const own = await api(`/api/surveys/${surveyInA}`, adminA.token);
    expect(own.status).toBe(200);

    // контракт scope.ts: 404 — методики нет, 403 — вне зоны ответственности.
    // Раскрытие факта существования внутри круга персонала — осознанный выбор:
    // явный отказ помогает разобраться с неверно настроенной группой
    const foreign = await api(`/api/surveys/${surveyInA}`, adminB.token);
    expect(foreign.status).toBe(403);
  });

  test("список пациентов у чужого админа пуст, у своего — после прохождения появляется", async () => {
    const before = await api("/api/access/patients", adminB.token);
    expect(before.body).toEqual([]);

    const beforeA = await api("/api/access/patients", adminA.token);
    expect(beforeA.body).toEqual([]); // пациент ещё не касался группы А
  });

  test("суперадмин видит всё", async () => {
    const all = await api("/api/access/patients", root.token);
    expect(all.body.length).toBe(1);
    const s = await api(`/api/surveys/${surveyInA}`, root.token);
    expect(s.status).toBe(200);
  });
});

/* ── сдача и атрибуция ── */

async function submitSurvey(surveyId: string, token: string, extra: Record<string, unknown> = {}) {
  const surveyRes = await api(`/api/surveys/${surveyId}`, token);
  if (surveyRes.status !== 200) return surveyRes;
  const survey = surveyRes.body;
  const answers = survey.questions
    .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
    .map((q: { id: string; options: { id: string }[] }) => ({
      questionId: q.id,
      optionIds: [q.options[1]?.id ?? q.options[0]!.id], // «Нет» — безопасные ответы
      durationMs: 2000,
      changeCount: 0,
      visitCount: 1,
    }));
  return api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
      ...extra,
    }),
  });
}

describe("сдача прохождения", () => {
  test("пациент сдаёт сам; прохождение записано на него", async () => {
    const res = await submitSurvey(surveyInA, patient.token);
    expect(res.status).toBe(201);
    expect(res.body.reliable).toBe(true);

    const detail = await api(`/api/responses/${res.body.id}`, root.token);
    expect(detail.status).toBe(200);
  });

  test("специалист заполняет за пациента — атрибуция на пациента, не на специалиста", async () => {
    const res = await submitSurvey(surveyInA, adminA.token, { onBehalfOf: patient.id });
    expect(res.status).toBe(201);

    const { responses } = await import("../src/db/schema");
    const row = await db.query.responses.findFirst({
      where: eq(responses.id, res.body.id),
    });
    expect(row!.userId).toBe(patient.id); // регресс на найденный баг
  });

  test("после прохождения пациент появляется в списке своего админа, но не чужого", async () => {
    const mine = await api("/api/access/patients", adminA.token);
    expect(mine.body.map((p: { id: string }) => p.id)).toContain(patient.id);

    const foreign = await api("/api/access/patients", adminB.token);
    expect(foreign.body).toEqual([]);
  });
});

/* ── батареи: строгий порядок и автозакрытие ── */

describe("батареи", () => {
  let batteryId: string;
  let secondSurvey: string;

  beforeAll(async () => {
    // вторая методика в группе А
    const input = createSurveySchema.parse(sr45);
    secondSurvey = crypto.randomUUID();
    await db.insert(surveys).values({
      id: secondSurvey,
      groupId: groupA,
      title: { uk: "Друга методика", ru: "Вторая методика" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(secondSurvey, input, adminA.id, "v1");

    batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      title: "Тестовая батарея",
      groupId: groupA,
      strictOrder: true,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([
      { batteryId, surveyId: surveyInA, position: 0, required: true },
      { batteryId, surveyId: secondSurvey, position: 1, required: true },
    ]);
  });

  test("назначение выдаёт доступ; пациенту нельзя сдать второй шаг раньше первого", async () => {
    const assign = await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect(assign.status).toBe(201);

    const out = await submitSurvey(secondSurvey, patient.token);
    expect(out.status).toBe(400);
    expect(out.body.error).toContain("строгий порядок");
  });

  test("после первого шага открывается второй; назначение закрывается само", async () => {
    const first = await submitSurvey(surveyInA, patient.token);
    expect(first.status).toBe(201);

    const second = await submitSurvey(secondSurvey, patient.token);
    expect(second.status).toBe(201);

    const rows = await db
      .select()
      .from(batteryAssignments)
      .where(eq(batteryAssignments.batteryId, batteryId));
    expect(rows[0]!.completedAt).not.toBeNull();
  });

  test("чужой админ не может назначить батарею группы А", async () => {
    const res = await api(`/api/batteries/${batteryId}/assign`, adminB.token, {
      method: "POST",
      body: JSON.stringify({ userId: patient.id }),
    });
    expect([403, 404]).toContain(res.status);
  });
});

/* ── планировщик: идемпотентность ── */

describe("планировщик", () => {
  test("два прогона подряд не плодят назначений", async () => {
    const scheduleId = crypto.randomUUID();
    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      title: "Батарея расписания",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId, surveyId: surveyInA, position: 0, required: true }]);
    await db.insert(schedules).values({
      id: scheduleId,
      title: "Тестовое расписание",
      batteryId,
      scope: "unit",
      unit: "Рота А",
      intervalDays: 30,
      dueDays: 7,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      nextRunAt: new Date(Date.now() - 1000).toISOString(),
      active: true,
      createdBy: adminA.id,
    });

    await runDueSchedules();
    await runDueSchedules(); // второй прогон должен быть пустым

    const assignments = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, batteryId), isNull(batteryAssignments.cancelledAt)));
    expect(assignments.length).toBe(1);

    const runs = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId));
    // срабатывание одно: второй прогон не дошёл до выдачи, срок уже сдвинут
    expect(runs.length).toBe(1);
    expect(runs[0]!.assigned).toBe(1);
  });
});

/* ── приглашения ── */

describe("приглашения", () => {
  let token: string;
  let code: string;
  let inviteBattery: string;

  beforeAll(async () => {
    inviteBattery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: inviteBattery,
      title: "Батарея приглашения",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId: inviteBattery, surveyId: surveyInA, position: 0, required: true }]);
  });

  test("создание: токен и код выдаются один раз", async () => {
    const res = await api("/api/invites", adminA.token, {
      method: "POST",
      body: JSON.stringify({ batteryId: inviteBattery, unit: "Рота Б", maxUses: 2, ttlDays: 7 }),
    });
    expect(res.status).toBe(201);
    token = res.body.token;
    code = res.body.code;
    expect(token.length).toBeGreaterThan(20);
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("предпросмотр публичен и не раскрывает лишнего", async () => {
    const res = await app.request(`/api/invites/preview/${token}`);
    const body = await res.json();
    expect(body.valid).toBe(true);
    expect(body.batteryTitle).toBe("Батарея приглашения");
    expect(Object.keys(body).sort()).toEqual(["batteryTitle", "unit", "valid"]);
  });

  test("регистрация по коду: батарея назначена, подразделение из приглашения", async () => {
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "invited@test.dev",
        password: "longpass123",
        anonymous: false,
        firstName: "Новый",
        lastName: "Пациент",
        inviteCode: code,
        unit: "своё-игнорируется",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.unit).toBe("Рота Б");

    const mine = await api("/api/batteries/mine", body.token);
    expect(mine.body.length).toBe(1);
    expect(mine.body[0].batteryTitle).toBe("Батарея приглашения");
  });

  test("лимит использований соблюдается атомарно", async () => {
    // второе из двух использований
    const second = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "invited2@test.dev", password: "longpass123", anonymous: true, inviteCode: code,
      }),
    });
    expect(second.status).toBe(201);

    // третье — отказ до создания аккаунта
    const third = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "invited3@test.dev", password: "longpass123", anonymous: true, inviteCode: code,
      }),
    });
    expect(third.status).toBe(400);
    const { users: usersTable } = await import("../src/db/schema");
    const ghost = await db.query.users.findFirst({ where: eq(usersTable.email, "invited3@test.dev") });
    expect(ghost).toBeUndefined();
  });

  test("отзыв гасит приглашение", async () => {
    const created = await api("/api/invites", adminA.token, {
      method: "POST",
      body: JSON.stringify({ maxUses: 5, ttlDays: 7 }),
    });
    await api(`/api/invites/${created.body.id}/revoke`, adminA.token, { method: "POST" });
    const preview = await app.request(`/api/invites/preview/${created.body.token}`);
    const body = await preview.json();
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("revoked");
  });

  test("чужой админ не видит приглашение группы А в списке", async () => {
    const mine = await api("/api/invites", adminA.token);
    expect(mine.body.length).toBeGreaterThan(0);
    const foreign = await api("/api/invites", adminB.token);
    const ids = foreign.body.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(mine.body.find((i: { batteryId: string | null }) => i.batteryId)?.id);
  });
});
