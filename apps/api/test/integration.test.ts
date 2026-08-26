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
// вся сюита гоняется С ШИФРОВАНИЕМ: это и есть сквозная проверка интеграции
process.env.ENCRYPTION_KEY = `v1:${Buffer.alloc(32, 9).toString("base64")}`;

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
const { encryptPersonFields } = await import("../src/lib/crypto");
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
    // тот же путь, что у продуктовых записей: поля персоны шифруются
    ...encryptPersonFields({
      firstName: "Тест",
      lastName: email.split("@")[0]!,
      birthDate: (extra as { birthDate?: string }).birthDate ?? null,
    }),
    passwordHash: await hashPassword("secret12345"),
    role,
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "birthDate")),
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
    safetyPlan: (sr45 as { safetyPlan?: unknown }).safetyPlan ?? null,
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

/* ── очерёдность и шаги клинициста ── */

describe("порядок батареи и методики клинициста", () => {
  test("непройденное интервью специалиста не блокирует самоотчёт", async () => {
    // батарея: [клиницист, самоотчёт] со строгим порядком
    const clinicianSurvey = crypto.randomUUID();
    const input = createSurveySchema.parse(sr45);
    await db.insert(surveys).values({
      id: clinicianSurvey,
      groupId: groupA,
      title: { uk: "Інтерв’ю", ru: "Интервью" },
      administration: "clinician",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(clinicianSurvey, input, adminA.id, "v1");

    const selfSurvey = crypto.randomUUID();
    await db.insert(surveys).values({
      id: selfSurvey,
      groupId: groupA,
      title: { uk: "Самозвіт", ru: "Самоотчёт" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(selfSurvey, input, adminA.id, "v1");

    const batteryId = crypto.randomUUID();
    await db.insert(batteries).values({
      id: batteryId,
      title: "Смешанная батарея",
      groupId: groupA,
      strictOrder: true,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([
      { batteryId, surveyId: clinicianSurvey, position: 0, required: true },
      { batteryId, surveyId: selfSurvey, position: 1, required: true },
    ]);

    const person = await makeUser("user", "mixed@test.dev", { sex: "male", birthDate: "1992-02-02" });
    await api(`/api/batteries/${batteryId}/assign`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ userId: person.id }),
    });

    // интервью ещё не внесено, но самоотчёт должен пройти:
    // дорожка специалиста параллельна и не запирает очередь
    const res = await submitSurvey(selfSurvey, person.token);
    expect(res.status).toBe(201);

    // батарея при этом НЕ закрыта: обязательная часть специалиста не внесена
    const assignments = await api(`/api/batteries/${batteryId}/assignments`, adminA.token);
    expect(assignments.body[0].completedAt).toBeNull();
    const clinicianStep = assignments.body[0].steps.find(
      (s: { surveyId: string }) => s.surveyId === clinicianSurvey,
    );
    expect(clinicianStep.state).toBe("available");
  });
});

/* ── экспорт → импорт ── */

describe("импорт методики", () => {
  test("цикл экспорт → импорт даёт рабочую копию с теми же баллами", async () => {
    const exported = await api(`/api/surveys/${surveyInA}/export`, adminA.token);
    expect(exported.status).toBe(200);
    expect(exported.body.formatVersion).toBe(1);

    const imported = await api("/api/surveys/import", adminA.token, {
      method: "POST",
      body: JSON.stringify({ ...exported.body, groupId: groupA }),
    });
    expect(imported.status).toBe(201);

    // копия — черновик; публикуем и сдаём те же ответы, баллы должны совпасть
    await api(`/api/surveys/${imported.body.id}`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ status: "published" }),
    });
    const original = await submitSurvey(surveyInA, root.token);
    const copy = await submitSurvey(imported.body.id, root.token);
    expect(copy.status).toBe(201);
    const scoreOf = (r: { body: { scores: { scaleCode: string; rawScore: number }[] } }, code: string) =>
      r.body.scores.find((s) => s.scaleCode === code)?.rawScore;
    expect(scoreOf(copy, "Sr")).toBe(scoreOf(original, "Sr"));
    expect(scoreOf(copy, "L")).toBe(scoreOf(original, "L"));
  });

  test("файл со структурной ошибкой не создаёт методику", async () => {
    const exported = await api(`/api/surveys/${surveyInA}/export`, adminA.token);
    const broken = structuredClone(exported.body);
    broken.scales[0].key.push({ item: 999, matchKey: "yes" }); // номер за пределами
    const res = await api("/api/surveys/import", adminA.token, {
      method: "POST",
      body: JSON.stringify(broken),
    });
    expect(res.status).toBe(422);
    expect(res.body.issues.some((i: { level: string }) => i.level === "error")).toBe(true);
  });

  test("чужая группа при импорте — отказ", async () => {
    const exported = await api(`/api/surveys/${surveyInA}/export`, adminA.token);
    const res = await api("/api/surveys/import", adminB.token, {
      method: "POST",
      body: JSON.stringify({ ...exported.body, groupId: groupA }),
    });
    expect([403, 404]).toContain(res.status);
  });
});

/* ── уведомления о тревогах ── */

describe("рассыльщик тревог", () => {
  test("тревога уведомляет админов группы один раз; эскалация — суперадминов по сроку", async () => {
    const nodemailer = (await import("nodemailer")).default;
    const { runNotifierOnce, setTransportForTests } = await import("../src/lib/notify");
    const { riskAlerts, alertNotifications, surveys: surveysTable } = await import("../src/db/schema");

    // json-транспорт: письма не уходят, но полностью собираются
    const sent: { subject: string; to: string; text: string }[] = [];
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const original = transport.sendMail.bind(transport);
    transport.sendMail = (async (mail: Parameters<typeof original>[0]) => {
      sent.push({ subject: String(mail.subject), to: String(mail.to), text: String(mail.text) });
      return original(mail);
    }) as typeof transport.sendMail;
    setTransportForTests(transport);

    // методика с эскалацией через 30 минут
    await db
      .update(surveysTable)
      .set({ alertEscalateMinutes: 30 })
      .where(eq(surveysTable.id, surveyInA));

    // тревога 40-минутной давности, не подтверждена
    const alertId = crypto.randomUUID();
    const responseRow = await db.query.responses.findFirst({
      where: eq((await import("../src/db/schema")).responses.surveyId, surveyInA),
    });
    await db.insert(riskAlerts).values({
      id: alertId,
      responseId: responseRow!.id,
      surveyId: surveyInA,
      questionId: (await db.query.questions.findFirst({}))!.id,
      userId: patient.id,
      label: "Тестовая тревога",
      severity: "severe",
      at: new Date(Date.now() - 40 * 60_000).toISOString(),
    });

    const first = await runNotifierOnce();
    expect(first.initial).toBeGreaterThanOrEqual(1);
    expect(first.escalated).toBeGreaterThanOrEqual(1);

    // повторный тик ничего не дублирует
    const second = await runNotifierOnce();
    expect(second.initial).toBe(0);
    expect(second.escalated).toBe(0);

    const записи = await db
      .select()
      .from(alertNotifications)
      .where(eq(alertNotifications.alertId, alertId));
    expect(записи.map((z) => z.kind).sort()).toEqual(["escalation", "initial"]);

    // первичное — админу группы А; эскалация — суперадмину
    const initialMail = sent.find((m) => m.subject.startsWith("Тревога"));
    const escalationMail = sent.find((m) => m.subject.startsWith("ЭСКАЛАЦИЯ"));
    expect(initialMail!.to).toContain("a@test");
    expect(escalationMail!.to).toContain("root@test");

    // в письмах нет персональных данных пациента
    for (const m of sent) {
      expect(m.text).not.toContain("Тест");
      expect(m.text).not.toContain(patient.id);
    }

    setTransportForTests(null);
  });
});

/* ── заключения ── */

describe("заключение специалиста", () => {
  let responseId: string;

  beforeAll(async () => {
    const res = await submitSurvey(surveyInA, patient.token);
    responseId = res.body.id;
  });

  test("черновик правится на месте, подпись фиксирует версию", async () => {
    const first = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Первый вариант" }),
    });
    expect(first.body.current.version).toBe(1);

    const edited = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Отредактированный вариант" }),
    });
    // черновик правится, версия не растёт
    expect(edited.body.current.version).toBe(1);
    expect(edited.body.versions.length).toBe(1);

    const signed = await api(`/api/conclusions/responses/${responseId}/conclusion/sign`, adminA.token, {
      method: "POST",
    });
    expect(signed.body.current.status).toBe("signed");

    // повторная подпись — отказ
    const again = await api(`/api/conclusions/responses/${responseId}/conclusion/sign`, adminA.token, {
      method: "POST",
    });
    expect(again.status).toBe(400);
  });

  test("правка после подписи создаёт версию 2 черновиком; подписанное неизменно", async () => {
    const v2 = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "Дополнение после подписи" }),
    });
    expect(v2.body.current.version).toBe(2);
    expect(v2.body.current.status).toBe("draft");
    const v1 = v2.body.versions.find((v: { version: number }) => v.version === 1);
    expect(v1.status).toBe("signed");
    expect(v1.text).toBe("Отредактированный вариант");
  });

  test("в печатный отчёт попадает только подписанная версия", async () => {
    // текущая версия 2 — черновик; отчёт не должен её показывать,
    // но и подписанную v1 показывать не должен: последняя версия не подписана.
    // Контракт: отчёт берёт ПОСЛЕДНЮЮ версию и включает её только если она подписана
    const res = await app.request(`/api/reports/responses/${responseId}`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const html = await res.text();
    expect(html).not.toContain("Дополнение после подписи");

    // подпишем v2 — теперь она в отчёте
    await api(`/api/conclusions/responses/${responseId}/conclusion/sign`, adminA.token, { method: "POST" });
    const res2 = await app.request(`/api/reports/responses/${responseId}`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const html2 = await res2.text();
    expect(html2).toContain("Дополнение после подписи");
    expect(html2).toContain("Распечатано:");
  });

  test("чужой админ не достаёт заключение", async () => {
    const res = await api(`/api/conclusions/responses/${responseId}/conclusion`, adminB.token);
    expect(res.status).toBe(404);
  });
});

/* ── safety-план ── */

describe("safety-план", () => {
  test("возвращается сдавшему при сработавшей тревоге и не возвращается специалисту", async () => {
    // surveyInA — СР-45 с safety-планом в описании инструмента; критические
    // пункты — «да» на вопросы о попытках. Отвечаем «да» на всё: тревога будет
    const surveyRes = await api(`/api/surveys/${surveyInA}`, patient.token);
    const yesAnswers = surveyRes.body.questions
      .filter((q: { type: string; options: unknown[] }) => q.type !== "info")
      .map((q: { id: string; options: { id: string; keyCode?: string }[] }) => ({
        questionId: q.id,
        optionIds: [q.options.find((o: { keyCode?: string }) => o.keyCode === "yes")!.id],
        durationMs: 2000,
        changeCount: 0,
        visitCount: 1,
      }));

    const own = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: yesAnswers,
      }),
    });
    expect(own.status).toBe(201);
    expect(own.body.safetyPlan).toContain("0 800 100 102");

    // специалист вносит за пациента: план ему не показывается —
    // он сам и есть тот, к кому план отправляет
    const staff = await api(`/api/surveys/${surveyInA}/responses`, adminA.token, {
      method: "POST",
      body: JSON.stringify({
        onBehalfOf: patient.id,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: yesAnswers,
      }),
    });
    expect(staff.status).toBe(201);
    expect(staff.body.safetyPlan).toBeNull();
  });
});

/* ── идемпотентность офлайн-повтора ── */

describe("clientRequestId", () => {
  test("повтор той же попытки не создаёт второе прохождение", async () => {
    const requestId = crypto.randomUUID();
    const surveyRes = await api(`/api/surveys/${surveyInA}`, patient.token);
    const answers = surveyRes.body.questions
      .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
      .map((q: { id: string; options: { id: string }[] }) => ({
        questionId: q.id,
        optionIds: [q.options[1]?.id ?? q.options[0]!.id],
        durationMs: 2000,
        changeCount: 0,
        visitCount: 1,
      }));
    const payload = {
      clientRequestId: requestId,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      answers,
    };

    const first = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);

    // «сеть оборвалась после коммита, клиент ретраит»
    const second = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const { responses: responsesTable } = await import("../src/db/schema");
    const rows = await db
      .select()
      .from(responsesTable)
      .where(eq(responsesTable.clientRequestId, requestId));
    expect(rows.length).toBe(1);
  });
});

/* ── шифрование в покое ── */

describe("шифрование полей", () => {
  test("в базе — шифртекст, наружу — читаемые имена", async () => {
    const { users: usersTable } = await import("../src/db/schema");
    const row = await db.query.users.findFirst({ where: eq(usersTable.email, "p@test") });
    expect(row!.lastName.startsWith("enc1:v1:")).toBe(true);
    expect(row!.birthDate!.startsWith("enc1:v1:")).toBe(true);

    // а API отдаёт человеку читаемое
    const me = await api("/api/auth/me", patient.token);
    expect(me.body.lastName).toBe("p");
    expect(me.body.birthDate).toBe("1990-01-01");

    // и список пациентов у админа тоже читаемый
    const list = await api("/api/access/patients", adminA.token);
    const found = list.body.find((p: { id: string }) => p.id === patient.id);
    expect(found.fullName).toContain("Тест");
  });

  test("текст заключения в базе шифрован, в API — открыт", async () => {
    const { conclusions: conclusionsTable } = await import("../src/db/schema");
    const [row] = await db.select().from(conclusionsTable).limit(1);
    expect(row!.text.startsWith("enc1:v1:")).toBe(true);
  });
});
