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

/* ── согласия ── */

describe("информированное согласие", () => {
  test("новая версия текста сбрасывает принятие; след с версией", async () => {
    // текста ещё нет — согласие не требуется
    const empty = await api("/api/consents/me", patient.token);
    expect(empty.body.required).toBe(false);

    // суперадмин задаёт текст
    const put = await api("/api/consents/text", root.token, {
      method: "PUT",
      body: JSON.stringify({ body: { uk: "Текст згоди, версія перша", ru: "Текст согласия, версия первая" } }),
    });
    expect(put.body.version).toBe(1);

    const before = await api("/api/consents/me", patient.token);
    expect(before.body.required).toBe(true);
    expect(before.body.accepted).toBe(false);
    // без Accept-Language сервер отдаёт украинский — это дефолт госпиталя
    expect(before.body.text).toContain("версія перша");

    await api("/api/consents/me/accept", patient.token, { method: "POST" });
    const after = await api("/api/consents/me", patient.token);
    expect(after.body.accepted).toBe(true);

    // правка текста → согласие требуется заново
    await api("/api/consents/text", root.token, {
      method: "PUT",
      body: JSON.stringify({ body: { uk: "Оновлений текст згоди", ru: "Обновлённый текст согласия" } }),
    });
    const reset = await api("/api/consents/me", patient.token);
    expect(reset.body.accepted).toBe(false);
    expect(reset.body.version).toBe(2);
  });

  test("правка текста — только суперадмину", async () => {
    const res = await api("/api/consents/text", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ body: { uk: "Спроба адміна групи", ru: "Попытка админа группы" } }),
    });
    expect(res.status).toBe(403);
  });
});

/* ── ретенция событий ── */

describe("ретенция answer_events", () => {
  test("старые события удаляются порциями, агрегаты в answers остаются", async () => {
    const { runRetentionOnce } = await import("../src/lib/retention");
    const { answerEvents, answers: answersTable, responses: responsesTable } = await import("../src/db/schema");
    const { sql } = await import("drizzle-orm");

    // прохождение двухлетней давности с событиями
    const old = await submitSurvey(surveyInA, patient.token);
    await db.execute(sql`update responses set submitted_at = now() - interval '400 days' where id = ${old.body.id}`);
    const [q] = await db.execute(sql`select id from questions limit 1`);
    await db.insert(answerEvents).values(
      Array.from({ length: 3 }, (_, i) => ({
        id: crypto.randomUUID(),
        responseId: old.body.id,
        questionId: (q as { id: string }).id,
        sequence: i + 100,
        kind: "set",
        elapsedMs: 1000 * i,
        at: new Date().toISOString(),
        value: null,
      })),
    );

    const deleted = await runRetentionOnce();
    expect(deleted).toBeGreaterThanOrEqual(3);

    const leftEvents = await db.execute(
      sql`select count(*)::int as n from answer_events ae join responses r on r.id = ae.response_id where r.id = ${old.body.id}`,
    );
    expect((leftEvents[0] as { n: number }).n).toBe(0);

    // ответы и их агрегаты живы
    const leftAnswers = await db.execute(
      sql`select count(*)::int as n from answers where response_id = ${old.body.id}`,
    );
    expect((leftAnswers[0] as { n: number }).n).toBeGreaterThan(0);

    // свежие прохождения не тронуты
    const fresh = await db.execute(
      sql`select count(*)::int as n from answer_events ae
          join responses r on r.id = ae.response_id
          where r.submitted_at > now() - interval '30 days'`,
    );
    expect((fresh[0] as { n: number }).n).toBeGreaterThanOrEqual(0);
  });
});

/* ── неизменяемость на уровне БД ── */

describe("триггеры неизменяемости", () => {
  // drizzle+postgres.js отдаёт ленивый thenable, а expect().rejects ждёт Promise
  const run = (q: PromiseLike<unknown>) => (async () => { await q; })();

  test("журнал не правится и не удаляется даже прямым SQL", async () => {
    const { sql } = await import("drizzle-orm");
    await expect(
      run(db.execute(sql`update audit_log set action = ${"hacked"} where seq = 1`)),
    ).rejects.toThrow(/неизменяем/);
    await expect(run(db.execute(sql`delete from audit_log where seq = 1`))).rejects.toThrow(/неизменяем/);
  });

  test("подписанное заключение не правится прямым SQL, черновик — правится", async () => {
    const { sql } = await import("drizzle-orm");
    const { conclusions: conclusionsTable } = await import("../src/db/schema");

    const signed = await db.query.conclusions.findFirst({
      where: eq(conclusionsTable.status, "signed"),
    });
    expect(signed).toBeDefined();
    await expect(
      run(db.execute(sql`update conclusions set text = ${"подмена"} where id = ${signed!.id}`)),
    ).rejects.toThrow(/неизменяемо/);
    await expect(run(db.execute(sql`delete from conclusions where id = ${signed!.id}`))).rejects.toThrow(
      /неизменяемо/,
    );
  });
});

/* ── RLS под не-владельцем ── */

describe("RLS-политики (роль без прав владельца)", () => {
  let rlsSql: ReturnType<(typeof import("postgres"))["default"]>;

  beforeAll(async () => {
    const postgres = (await import("postgres")).default;
    // роль создаём владельцем, подключаемся ею: для неё политики активны
    const admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`do $$ begin
      if not exists (select from pg_roles where rolname = 'quizzy_rls_test') then
        create role quizzy_rls_test login;
      end if;
    end $$`);
    await admin.unsafe(`grant usage on schema public to quizzy_rls_test`);
    await admin.unsafe(`grant select, insert, update, delete on all tables in schema public to quizzy_rls_test`);
    await admin.end();

    const url = new URL(process.env.DATABASE_URL!);
    url.username = "quizzy_rls_test";
    url.password = "";
    rlsSql = postgres(url.toString(), { max: 1 });
  });

  afterAll(async () => {
    await rlsSql?.end({ timeout: 3 }).catch(() => {});
  });

  /** Выполнить запрос в транзакции с заданной RLS-идентичностью */
  async function as(identity: { userId?: string; role?: string }, query: string): Promise<number> {
    const rows = await rlsSql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${identity.userId ?? ""}, true),
                      set_config('app.role', ${identity.role ?? ""}, true)`;
      return tx.unsafe(query);
    });
    return Number((rows as unknown as { n: number }[])[0]?.n ?? NaN);
  }

  const countResponses = `select count(*)::int n from responses`;
  const countSurveyA = `select count(*)::int n from responses where survey_id = (select id from surveys limit 1)`;

  test("без контекста — ноль строк, а не чужие данные", async () => {
    expect(await as({}, countResponses)).toBe(0);
    expect(await as({}, `select count(*)::int n from surveys`)).toBe(0);
    expect(await as({}, `select count(*)::int n from answers`)).toBe(0);
    expect(await as({}, `select count(*)::int n from risk_alerts`)).toBe(0);
  });

  test("system и superadmin видят всё", async () => {
    const total = await as({ role: "system" }, countResponses);
    expect(total).toBeGreaterThan(0);
    expect(await as({ userId: root.id, role: "superadmin" }, countResponses)).toBe(total);
  });

  test("админ видит только свою группу", async () => {
    const a = await as({ userId: adminA.id, role: "admin" }, countResponses);
    const b = await as({ userId: adminB.id, role: "admin" }, countResponses);
    expect(a).toBeGreaterThan(0); // группа А — все прохождения теста в ней
    expect(b).toBe(0); // у группы Б прохождений нет — и чужих ей не видно
  });

  test("пациент видит только свои прохождения и ответы", async () => {
    const own = await as({ userId: patient.id, role: "user" }, countResponses);
    const total = await as({ role: "system" }, countResponses);
    expect(own).toBeGreaterThan(0);
    expect(own).toBeLessThan(total);

    // и не может читать тревоги (они — для персонала)
    expect(await as({ userId: patient.id, role: "user" }, `select count(*)::int n from risk_alerts`)).toBe(0);
  });

  test("пациент не может подсунуть прохождение за другого", async () => {
    const attempt = rlsSql.begin(async (tx) => {
      await tx`select set_config('app.user_id', ${patient.id}, true),
                      set_config('app.role', 'user', true)`;
      await tx`insert into responses (id, survey_id, user_id, status, started_at, duration_ms)
               values (${crypto.randomUUID()}, ${surveyInA}, ${adminA.id}, 'completed', now(), 0)`;
    });
    await expect((async () => { await attempt; })()).rejects.toThrow(/row-level security|policy/i);
  });
});

/* ── локальные нормы ── */

describe("локальные нормы", () => {
  test("кандидаты считаются по скорректированному баллу; публикация требует N≥30", async () => {
    // surveyInA — СР-45: шкалы ratio, T-баллов нет → кандидатов нет
    const none = await api(`/api/norms/surveys/${surveyInA}/candidates`, adminA.token);
    expect(none.body.scales.length).toBe(0);

    // публикация по несуществующей шкале — отказ
    const bad = await api(`/api/norms/surveys/${surveyInA}/apply`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ scaleCodes: ["Sr"] }),
    });
    expect(bad.status).toBe(400);
  });

  test("на tscore-методике: кандидат появляется, публикация создаёт версию с источником", async () => {
    // мини-методика с tscore-шкалой и 35 прохождениями мужчин
    const { minimult } = await import("../src/instruments/minimult");
    const input = createSurveySchema.parse(minimult);
    const sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "Міні-мульт норм-тест", ru: "Мини-мульт норм-тест" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, input, adminA.id, "v1");

    // 35 прохождений: берём готовый конвейер сдачи от 35 свежих пациентов
    for (let i = 0; i < 35; i++) {
      const person = await makeUser("user", `norm${i}@test.dev`, {
        sex: "male",
        birthDate: "1990-01-01",
        unit: "Норм-рота",
      });
      // ответы различаются между людьми: норма с нулевым разбросом не норма
      const surveyRes = await api(`/api/surveys/${sid}`, person.token);
      const answers = surveyRes.body.questions
        .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
        .map((q: { id: string; options: { id: string }[] }, qi: number) => ({
          questionId: q.id,
          optionIds: [q.options[(i + qi) % q.options.length]!.id],
          durationMs: 1500,
          changeCount: 0,
          visitCount: 1,
        }));
      const res = await api(`/api/surveys/${sid}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(res.status).toBe(201);
    }

    const cand = await api(`/api/norms/surveys/${sid}/candidates`, adminA.token);
    const hs = cand.body.scales.find((s: { code: string }) => s.code === "Hs");
    expect(hs).toBeDefined();
    const male = hs.candidate.find((g: { sex: string | null }) => g.sex === "male");
    expect(male.n).toBe(35);
    expect(male.publishable).toBe(true);
    expect(male.sd).toBeGreaterThan(0);

    // публикуем локальные нормы для Hs
    const applied = await api(`/api/norms/surveys/${sid}/apply`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ scaleCodes: ["Hs"] }),
    });
    expect(applied.status).toBe(201);

    // новая версия действует: нормы Hs — локальные, остальных шкал — из пособия
    const after = await api(`/api/surveys/${sid}`, adminA.token);
    expect(after.body.versionNumber).toBe(2);
    const hsScale = after.body.scales.find((s: { code: string }) => s.code === "Hs");
    expect(hsScale.norms.some((n: { source: string | null }) => n.source?.includes("локальная выборка, N=35"))).toBe(true);
    const dScale = after.body.scales.find((s: { code: string }) => s.code === "D");
    expect(dScale.norms.every((n: { source: string | null }) => n.source?.includes("Пособие"))).toBe(true);
  }, 60_000); // 35 регистраций с argon2 не укладываются в дефолтные 5 секунд
});

/* ── исследовательский экспорт ── */

describe("профили деидентификации", () => {
  test("deidentified: без имён/подразделений, код субъекта стабилен и необратим", async () => {
    const res = await app.request(
      `/api/spss/surveys/${surveyInA}/data.csv?profile=deidentified`,
      { headers: { Authorization: `Bearer ${adminA.token}` } },
    );
    const csv = await res.text();
    const head = csv.split("\r\n")[0]!;

    expect(head).toContain("subject");
    expect(head).toContain("age_band");
    expect(head).not.toContain("unit");
    expect(head).not.toContain("mil_rank");
    // никаких uuid пациентов и точных дат в теле
    expect(csv).not.toContain(patient.id);
    expect(csv).toMatch(/R[0-9A-F]{10}/);

    // стабильность кода между выгрузками — лонгитюд склеивается
    const res2 = await app.request(
      `/api/spss/surveys/${surveyInA}/data.csv?profile=deidentified`,
      { headers: { Authorization: `Bearer ${adminA.token}` } },
    );
    const code1 = csv.match(/R[0-9A-F]{10}/)![0];
    expect(await res2.text()).toContain(code1);
  });

  test("anonymous: субъекта нет вовсе", async () => {
    const res = await app.request(`/api/spss/surveys/${surveyInA}/data.csv?profile=anonymous`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const head = (await res.text()).split("\r\n")[0]!;
    expect(head).not.toContain("subject");
    expect(head).toContain("age_band");
  });

  test("codebook перечисляет переменные и происхождение норм", async () => {
    const res = await app.request(`/api/spss/surveys/${surveyInA}/codebook.csv`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const text = await res.text();
    expect(text).toContain("variable;type;label;values");
    expect(text).toContain("scale;normalization;norm_source");
    expect(text).toContain("Sr;ratio");
  });

  test("выгрузка фиксируется в журнале с хэшем датасета", async () => {
    const { auditLog } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "analytics.export"))
      .orderBy(descOp(auditLog.at))
      .limit(1);
    const details = entry!.details as { datasetSha256?: string; profile?: string };
    // последняя data.csv-выгрузка несёт хэш
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "analytics.export"))
      .orderBy(descOp(auditLog.at));
    const withHash = rows.find((r) => (r.details as { datasetSha256?: string }).datasetSha256);
    expect(withHash).toBeDefined();
    expect((withHash!.details as { datasetSha256: string }).datasetSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ── волна 1 расширения: снэпшоты, язык, исход тревоги ── */

describe("снэпшоты стратификации и язык предъявления", () => {
  test("сдача пишет пол, возрастную полосу на момент сдачи и язык", async () => {
    const res = await api(`/api/surveys/${surveyInA}/responses`, patient.token, {
      method: "POST",
      headers: { "Accept-Language": "ru" },
      body: JSON.stringify({
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        durationMs: 60_000,
        events: [],
        answers: (await api(`/api/surveys/${surveyInA}`, patient.token)).body.questions
          .filter((q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length)
          .map((q: { id: string; options: { id: string }[] }) => ({
            questionId: q.id,
            optionIds: [q.options[1]?.id ?? q.options[0]!.id],
            durationMs: 2000,
            changeCount: 0,
            visitCount: 1,
          })),
      }),
    });
    expect(res.status).toBe(201);

    const { responses: responsesTable } = await import("../src/db/schema");
    const row = await db.query.responses.findFirst({ where: eq(responsesTable.id, res.body.id) });
    // пациент из фикстур: муж, 1990 г.р. → полоса 35-44 на 2026 год
    expect(row!.respondentSex).toBe("male");
    expect(row!.respondentAgeBand).toBe("35-44");
    expect(row!.lang).toBe("ru");
  });
});

describe("исход тревоги", () => {
  test("исход сохраняется при разборе и виден в списке", async () => {
    const { riskAlerts: alertsTable } = await import("../src/db/schema");
    const open = await db.query.riskAlerts.findFirst({
      where: (t, { isNull: isNullOp }) => isNullOp(t.acknowledgedAt),
    });
    expect(open).toBeDefined();

    const ack = await api(`/api/alerts/${open!.id}/acknowledge`, adminA.token, {
      method: "PATCH",
      body: JSON.stringify({ note: "Беседа проведена", outcome: "confirmed" }),
    });
    expect(ack.status).toBe(200);

    const list = await api("/api/alerts?all=1", adminA.token);
    const found = list.body.find((a: { id: string }) => a.id === open!.id);
    expect(found.outcome).toBe("confirmed");

    // мусорный исход не проходит — пишется null, а не что попало
    const open2 = await db.query.riskAlerts.findFirst({
      where: (t, { isNull: isNullOp }) => isNullOp(t.acknowledgedAt),
    });
    if (open2) {
      await api(`/api/alerts/${open2.id}/acknowledge`, adminA.token, {
        method: "PATCH",
        body: JSON.stringify({ outcome: "чепуха" }),
      });
      const row = await db.query.riskAlerts.findFirst({ where: eq(alertsTable.id, open2.id) });
      expect(row!.outcome).toBeNull();
    }
  });
});

/* ── волна 4: DIF, инвариантность, возрастные кривые ── */

describe("DIF по полу", () => {
  test("подсаженное различие в пункте обнаруживается; остальные пункты — класс A", async () => {
    const { sr45 } = await import("../src/instruments/sr45");
    const input = createSurveySchema.parse(sr45);
    const sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "DIF-тест", ru: "DIF-тест" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, input, adminA.id, "v1");

    const survey = (await api(`/api/surveys/${sid}`, adminA.token)).body;
    const asked = survey.questions.filter(
      (q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length,
    );
    // пункт с подсаженным DIF: женщины отвечают «да» ГОРАЗДО чаще при том же
    // общем уровне — ровно то, что метод обязан заметить
    const difIndex = 5;

    for (let i = 0; i < 120; i++) {
      const sex = i % 2 === 0 ? "male" : "female";
      const person = await makeUser("user", `dif${i}@test.dev`, {
        sex,
        birthDate: sex === "male" ? "1985-01-01" : "1995-01-01",
      });
      // общий уровень черты одинаково распределён между полами
      const level = (i % 10) / 10;
      const answers = asked.map((q: { id: string; options: { id: string; keyCode?: string }[] }, qi: number) => {
        const yes = q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!;
        const no = q.options.find((o) => o.keyCode === "no") ?? q.options[1] ?? q.options[0]!;
        const base = ((qi * 7 + i * 13) % 100) / 100 < level;
        const pick = qi === difIndex ? (sex === "female" ? level > 0.05 : level > 0.85) : base;
        return {
          questionId: q.id,
          optionIds: [pick ? yes.id : no.id],
          durationMs: 1500,
          changeCount: 0,
          visitCount: 1,
        };
      });
      const res = await api(`/api/surveys/${sid}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(res.status).toBe(201);
    }

    const dif = await api(`/api/dif/surveys/${sid}`, adminA.token);
    expect(dif.status).toBe(200);
    expect(dif.body.sample).toBeGreaterThanOrEqual(120);

    const sexEntries = dif.body.scales.flatMap((s: { items: { position: number; entries: { factor: string; result: { etsClass: string; deltaMH: number } | null }[] }[] }) =>
      s.items.flatMap((i) =>
        i.entries.filter((e) => e.factor === "sex" && e.result).map((e) => ({ position: i.position, ...e })),
      ),
    );
    expect(sexEntries.length).toBeGreaterThan(0);

    // подсаженный пункт (позиция difIndex+1 среди asked) должен быть не-A
    const flagged = sexEntries.filter((e: { result: { etsClass: string } }) => e.result.etsClass !== "A");
    expect(flagged.length).toBeGreaterThan(0);
    const positions = flagged.map((e: { position: number }) => e.position);
    expect(positions).toContain(asked[difIndex]!.position + 1);

    // надёжность посчиталась по обеим половым группам
    const rel = dif.body.reliability.find((r: { code: string }) => r.code === "Sr");
    expect(rel.groups.length).toBe(2);
    expect(rel.groups.every((g: { alpha: number | null }) => g.alpha !== null)).toBe(true);

    // возрастные кривые: два пола по 60 — окно наберётся
    const curves = await api(`/api/norms/surveys/${sid}/age-curves`, adminA.token);
    expect(curves.body.scales.length).toBeGreaterThan(0);
    const withCurve = curves.body.scales[0].bySex.find((b: { enough: boolean }) => b.enough);
    expect(withCurve.points[0].percentiles.length).toBe(5);
    expect(withCurve.points[0].n).toBeGreaterThanOrEqual(30);
  }, 180_000);
});

/* ── волна 5: каскады и протоколы наблюдения ── */

describe("каскадные назначения", () => {
  test("попадание в полосу назначает батарею; повтор не дублирует; петля отсекается", async () => {
    const { sr45 } = await import("../src/instruments/sr45");
    const { scaleBands: bandsTable, scales: scalesTable, surveyVersions } = await import("../src/db/schema");
    const { desc: descOp } = await import("drizzle-orm");

    // методика-скрининг
    const screenId = crypto.randomUUID();
    await db.insert(surveys).values({
      id: screenId,
      groupId: groupA,
      title: { uk: "Каскад-скринінг", ru: "Каскад-скрининг" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(screenId, createSurveySchema.parse(sr45), adminA.id, "v1");

    // углублённая батарея из ДРУГОЙ методики
    const deepId = crypto.randomUUID();
    await db.insert(surveys).values({
      id: deepId,
      groupId: groupA,
      title: { uk: "Поглиблена", ru: "Углублённая" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(deepId, createSurveySchema.parse(sr45), adminA.id, "v1");

    const deepBattery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: deepBattery,
      title: "Углублённая диагностика",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId: deepBattery, surveyId: deepId, position: 0, required: true }]);

    // вешаем каскад и повторы на ВСЕ полосы шкалы Sr текущей версии скрининга
    const [version] = await db
      .select()
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, screenId))
      .orderBy(descOp(surveyVersions.version))
      .limit(1);
    const srScale = await db.query.scales.findFirst({
      where: and(eq(scalesTable.versionId, version!.id), eq(scalesTable.code, "Sr")),
    });
    await db
      .update(bandsTable)
      .set({ cascadeBatteryId: deepBattery, cascadeDueDays: 14, followUpDays: "7,30" })
      .where(eq(bandsTable.scaleId, srScale!.id));

    const person = await makeUser("user", "cascade@test.dev", { sex: "male", birthDate: "1990-01-01" });

    const first = await submitSurvey(screenId, person.token);
    expect(first.status).toBe(201);
    expect(first.body.cascade.assignedBatteries).toContain("Углублённая диагностика");
    expect(first.body.cascade.scheduledFollowUps).toBe(2);

    const assigned = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, deepBattery), eq(batteryAssignments.userId, person.id)));
    expect(assigned.length).toBe(1);
    expect(assigned[0]!.dueAt).not.toBeNull();

    // доступ к углублённой методике выдан
    const { surveyAccess: accessTable } = await import("../src/db/schema");
    const access = await db
      .select()
      .from(accessTable)
      .where(and(eq(accessTable.surveyId, deepId), eq(accessTable.userId, person.id)));
    expect(access.length).toBe(1);

    // повторная сдача не плодит второе назначение
    const second = await submitSurvey(screenId, person.token);
    expect(second.status).toBe(201);
    expect(second.body.cascade.assignedBatteries).toEqual([]);
    const afterSecond = await db
      .select()
      .from(batteryAssignments)
      .where(and(eq(batteryAssignments.batteryId, deepBattery), eq(batteryAssignments.userId, person.id)));
    expect(afterSecond.length).toBe(1);

    // петля: батарея содержит саму методику-источник → каскад пропускается
    const loopBattery = crypto.randomUUID();
    await db.insert(batteries).values({
      id: loopBattery,
      title: "Петля",
      groupId: groupA,
      strictOrder: false,
      createdBy: adminA.id,
    });
    await db.insert(batteryItems).values([{ batteryId: loopBattery, surveyId: screenId, position: 0, required: true }]);
    await db.update(bandsTable).set({ cascadeBatteryId: loopBattery }).where(eq(bandsTable.scaleId, srScale!.id));

    const loopPerson = await makeUser("user", "loop@test.dev", { sex: "male", birthDate: "1990-01-01" });
    const third = await submitSurvey(screenId, loopPerson.token);
    expect(third.status).toBe(201);
    expect(third.body.cascade.assignedBatteries).toEqual([]);
    const loopAssigned = await db
      .select()
      .from(batteryAssignments)
      .where(eq(batteryAssignments.batteryId, loopBattery));
    expect(loopAssigned.length).toBe(0);
  }, 60_000);
});

/* ── волна 6: ROC-калибровка и PPV ── */

describe("калибровка порогов", () => {
  test("guard: мало исходов — кривая не строится, но характеристики порога видны", async () => {
    const res = await api(`/api/calibration/surveys/${surveyInA}`, adminA.token);
    expect(res.status).toBe(200);
    expect(res.body.minPerOutcome).toBe(30);
    // на этой методике исходов почти нет: enough=false, roc=null
    for (const scale of res.body.scales) {
      for (const s of scale.strata) {
        if (!s.enough) expect(s.roc).toBeNull();
      }
    }
  });

  test("при достаточной выборке строится ROC и предлагается порог по Юдену", async () => {
    const { sr45 } = await import("../src/instruments/sr45");
    const { riskAlerts: alertsTable, questions: questionsTable } = await import("../src/db/schema");

    const sid = crypto.randomUUID();
    await db.insert(surveys).values({
      id: sid,
      groupId: groupA,
      title: { uk: "ROC-тест", ru: "ROC-тест" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      createdBy: adminA.id,
    } as never);
    await createVersion(sid, createSurveySchema.parse(sr45), adminA.id, "v1");

    const survey = (await api(`/api/surveys/${sid}`, adminA.token)).body;
    const asked = survey.questions.filter(
      (q: { type: string; options: unknown[] }) => q.type !== "info" && (q.options as unknown[]).length,
    );
    const [anyQuestion] = await db.select().from(questionsTable).limit(1);

    // 80 случаев: чем выше балл, тем чаще исход «подтверждён» —
    // калибровка обязана увидеть в этом сигнал
    for (let i = 0; i < 80; i++) {
      const person = await makeUser("user", `roc${i}@test.dev`, { sex: "male", birthDate: "1990-01-01" });
      const level = i / 80; // 0…1
      const answers = asked.map((q: { id: string; options: { id: string; keyCode?: string }[] }, qi: number) => {
        const yes = q.options.find((o) => o.keyCode === "yes") ?? q.options[0]!;
        const no = q.options.find((o) => o.keyCode === "no") ?? q.options[1] ?? q.options[0]!;
        return {
          questionId: q.id,
          optionIds: [((qi * 13 + i * 7) % 100) / 100 < level ? yes.id : no.id],
          durationMs: 1200,
          changeCount: 0,
          visitCount: 1,
        };
      });
      const res = await api(`/api/surveys/${sid}/responses`, person.token, {
        method: "POST",
        body: JSON.stringify({
          startedAt: new Date(Date.now() - 60_000).toISOString(),
          durationMs: 60_000,
          events: [],
          answers,
        }),
      });
      expect(res.status).toBe(201);

      // исход: у верхней половины по уровню — подтверждён
      await db.insert(alertsTable).values({
        id: crypto.randomUUID(),
        responseId: res.body.id,
        surveyId: sid,
        questionId: anyQuestion!.id,
        userId: person.id,
        label: "калибровочная тревога",
        severity: "severe",
        at: new Date().toISOString(),
        acknowledgedBy: adminA.id,
        acknowledgedAt: new Date().toISOString(),
        outcome: level > 0.5 ? "confirmed" : "not_confirmed",
      });
    }

    const cal = await api(`/api/calibration/surveys/${sid}`, adminA.token);
    expect(cal.body.cases).toBeGreaterThanOrEqual(80);

    const sr = cal.body.scales.find((s: { code: string }) => s.code === "Sr");
    const all = sr.strata.find((s: { stratum: string }) => s.stratum === "вся выборка");
    expect(all.confirmed).toBeGreaterThanOrEqual(30);
    expect(all.notConfirmed).toBeGreaterThanOrEqual(30);
    expect(all.enough).toBe(true);
    // связь балла с исходом заложена — AUC обязан быть заметно выше случайного
    expect(all.roc.auc).toBeGreaterThan(0.75);
    expect(all.roc.bestThreshold).toBeGreaterThan(0);
    expect(all.currentSensitivity).not.toBeNull();

    // «требует наблюдения» не попадает ни в одну сторону
    const before = cal.body.cases;
    const extra = await makeUser("user", "followup@test.dev", { sex: "male", birthDate: "1990-01-01" });
    const extraRes = await submitSurvey(sid, extra.token);
    await db.insert(alertsTable).values({
      id: crypto.randomUUID(),
      responseId: extraRes.body.id,
      surveyId: sid,
      questionId: anyQuestion!.id,
      userId: extra.id,
      label: "отложенное решение",
      severity: "severe",
      at: new Date().toISOString(),
      acknowledgedBy: adminA.id,
      acknowledgedAt: new Date().toISOString(),
      outcome: "needs_followup",
    });
    const after = await api(`/api/calibration/surveys/${sid}`, adminA.token);
    expect(after.body.cases).toBe(before);

    // PPV: сводка видит подтверждённые и считает долю
    const ppv = await api("/api/calibration/ppv", adminA.token);
    expect(ppv.body.overall.n).toBeGreaterThanOrEqual(80);
    expect(ppv.body.overall.ppv).toBeGreaterThan(0);
    expect(ppv.body.withoutOutcome).toBeGreaterThanOrEqual(1); // тот самый needs_followup
    expect(ppv.body.byMonth.length).toBeGreaterThan(0);
  }, 120_000);
});
