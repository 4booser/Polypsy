import { afterAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  adminA,
  and,
  api,
  createSurveySchema,
  createVersion,
  db,
  eq,
  groupA,
  groupAdmins,
  makeUser,
  root,
  sql,
  surveyInA,
  surveys,
} from "./fixtures";
import {
  alertCases,
  auditLog,
  consentTexts,
  consents,
  loginAttempts,
  permissionExceptions,
  referrals,
  responseScores,
  responses,
  riskAlerts,
  surveyAccess,
  surveyVersions,
} from "../src/db/schema";
import { requireAuth, type AppEnv } from "../src/middleware/auth";
import { durable } from "../src/db/context";
import { audit } from "../src/lib/audit";
import { badRequest, forbidden } from "../src/lib/http";
import { underAppRole } from "./appRole";

/**
 * Сдача прохождения: целостность данных и права (волна 12, участок submit).
 *
 * Четыре дефекта из внешнего разбора, каждый воспроизведён тестом, который
 * падал до правки:
 *   1. неудачный ответ не откатывал транзакцию запроса — сдача с неверным
 *      ответом получала 400 и теряла черновик;
 *   2. начатое прохождение не было привязано к версии методики;
 *   3. ограничение доступа проверялось на открытии, но не на сдаче;
 *   4. заполнение за пациента не проверяло зону видимости.
 *
 * Данные у каждого теста свои (uuid в почтах и названиях): файлы сюиты идут
 * одним процессом и на Linux в другом порядке, чем на macOS.
 */

const tag = () => crypto.randomUUID().slice(0, 8);

/** Два обязательных пункта «Так/Ні» и шкала-сумма; вес «Так» задаёт версию */
function content(yesScore: number) {
  const item = (uk: string) => ({
    type: "single" as const,
    title: { uk, ru: uk },
    required: true,
    scaleCode: "S",
    options: [
      { text: { uk: "Так", ru: "Да" }, score: yesScore },
      { text: { uk: "Ні", ru: "Нет" }, score: 0 },
    ],
  });
  return createSurveySchema.parse({
    title: { uk: "Методика сдачи", ru: "Методика сдачи" },
    administration: "self",
    scoringEnabled: true,
    questions: [item("Перший пункт"), item("Другий пункт")],
    scales: [
      {
        code: "S",
        title: { uk: "Сума", ru: "Сумма" },
        kind: "clinical",
        normalization: "raw",
        bands: [],
      },
    ],
  });
}

async function makeSurvey(visibility: "public" | "restricted" = "public"): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Сдача ${tag()}`, ru: "Сдача" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility,
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  await createVersion(id, content(1), adminA.id, "v1");
  return id;
}

type Loaded = { versionId: string; questions: { id: string; options: { id: string }[] }[] };

/** Ответы «Так» на все пункты показанной версии */
function yesAnswers(survey: Loaded) {
  return survey.questions.map((q) => ({
    questionId: q.id,
    optionIds: [q.options[0]!.id],
    durationMs: 1500,
    changeCount: 0,
    visitCount: 1,
  }));
}

function submit(surveyId: string, token: string, body: Record<string, unknown>) {
  return api(`/api/surveys/${surveyId}/responses`, token, {
    method: "POST",
    body: JSON.stringify({
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      durationMs: 60_000,
      events: [],
      ...body,
    }),
  });
}

function saveDraft(surveyId: string, token: string, body: Record<string, unknown>) {
  return api(`/api/surveys/${surveyId}/draft`, token, {
    method: "PUT",
    body: JSON.stringify({ startedAt: new Date(Date.now() - 60_000).toISOString(), durationMs: 30_000, ...body }),
  });
}

async function denials(actorId: string, reason: string) {
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.actorId, actorId), eq(auditLog.outcome, "denied")));
  return rows.filter((r) => (r.details as { reason?: string } | null)?.reason === reason);
}

/* ─────────── 1. неудачный ответ откатывает транзакцию запроса ─────────── */

/*
 * Проба middleware: свои маршруты поверх настоящего requireAuth и
 * onError, устроенного как в app.ts (исключение → ответ). Пишут строку в
 * login_attempts — таблицу без внешних ключей — с почтой-меткой пробы.
 */
const probe = new Hono<AppEnv>();
probe.use("*", requireAuth);
const mark = (email: string) => db.insert(loginAttempts).values({ id: crypto.randomUUID(), email, ip: null });
probe.post("/throw/:email", async (c) => {
  await mark(c.req.param("email"));
  badRequest("err.internal");
});
probe.post("/refuse/:email", async (c) => {
  await mark(c.req.param("email"));
  return c.json({ error: "refused" }, 409);
});
probe.post("/crash/:email", async (c) => {
  await mark(c.req.param("email"));
  throw new Error("сбой обработчика");
});
probe.post("/ok/:email", async (c) => {
  await mark(c.req.param("email"));
  return c.json({ ok: true });
});
probe.post("/denied/:email", async (c) => {
  await mark(c.req.param("email"));
  await audit(c, {
    action: "access.denied",
    outcome: "denied",
    resourceType: "route",
    resourceId: c.req.param("email"),
    details: { reason: "probe" },
  });
  forbidden("err.forbidden");
});
probe.post("/durable/:email", async (c) => {
  const email = c.req.param("email");
  await mark(`plain-${email}`);
  await durable(() => mark(`kept-${email}`));
  badRequest("err.internal");
});
probe.get("/write/:email", async (c) => {
  await mark(c.req.param("email"));
  return c.json({ ok: true });
});
probe.onError((err, c) =>
  err instanceof HTTPException ? c.json({ error: err.message }, err.status) : c.json({ error: "internal" }, 500),
);

async function marked(email: string): Promise<number> {
  const rows = await db.select().from(loginAttempts).where(eq(loginAttempts.email, email));
  return rows.length;
}

describe("транзакция запроса", () => {
  test("исключение, которое onError превратил в ответ 400, откатывает записанное до него", async () => {
    const person = await makeUser("user", `probe-${tag()}@test.dev`);
    const email = `throw-${tag()}@probe`;
    const res = await probe.request(`/throw/${email}`, { method: "POST", headers: { Authorization: `Bearer ${person.token}` } });
    expect(res.status).toBe(400);
    expect(await marked(email), "запись пережила отказ — транзакция зафиксировалась").toBe(0);
  });

  test("отказ ответом (409) без исключения откатывает так же", async () => {
    const person = await makeUser("user", `probe-${tag()}@test.dev`);
    const email = `refuse-${tag()}@probe`;
    const res = await probe.request(`/refuse/${email}`, { method: "POST", headers: { Authorization: `Bearer ${person.token}` } });
    expect(res.status).toBe(409);
    expect(await marked(email)).toBe(0);
  });

  test("необработанное исключение (500) откатывает", async () => {
    const person = await makeUser("user", `probe-${tag()}@test.dev`);
    const email = `crash-${tag()}@probe`;
    const res = await probe.request(`/crash/${email}`, { method: "POST", headers: { Authorization: `Bearer ${person.token}` } });
    expect(res.status).toBe(500);
    expect(await marked(email)).toBe(0);
  });

  test("успешный ответ фиксирует", async () => {
    const person = await makeUser("user", `probe-${tag()}@test.dev`);
    const email = `ok-${tag()}@probe`;
    const res = await probe.request(`/ok/${email}`, { method: "POST", headers: { Authorization: `Bearer ${person.token}` } });
    expect(res.status).toBe(200);
    expect(await marked(email)).toBe(1);
  });

  test("строка журнала об отказе переживает откат, остальное — нет", async () => {
    const person = await makeUser("user", `probe-${tag()}@test.dev`);
    const email = `denied-${tag()}@probe`;
    const res = await probe.request(`/denied/${email}`, { method: "POST", headers: { Authorization: `Bearer ${person.token}` } });
    expect(res.status).toBe(403);
    expect(await marked(email)).toBe(0);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.actorId, person.id), eq(auditLog.resourceId, email)));
    expect(rows.length, "отказ пропал из журнала вместе с откатом").toBe(1);
    expect(rows[0]!.outcome).toBe("denied");
  });

  test("durable-запись повторяется после отката ровно один раз", async () => {
    const person = await makeUser("user", `probe-${tag()}@test.dev`);
    const email = `${tag()}@probe`;
    const res = await probe.request(`/durable/${email}`, { method: "POST", headers: { Authorization: `Bearer ${person.token}` } });
    expect(res.status).toBe(400);
    expect(await marked(`plain-${email}`)).toBe(0);
    expect(await marked(`kept-${email}`)).toBe(1);
  });
});

describe("сдача с неверным ответом", () => {
  test("400 — и черновик цел", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `draft-keep-${tag()}@test.dev`, { sex: "female", birthDate: "1991-02-02" });
    const loaded = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;

    const saved = await saveDraft(surveyId, person.token, { versionId: loaded.versionId, answers: yesAnswers(loaded) });
    expect(saved.status).toBe(200);

    // вариант чужого пункта — отказ формы ответа, и он случается ПОСЛЕ удаления черновика
    const broken = yesAnswers(loaded);
    broken[1]!.optionIds = [loaded.questions[0]!.options[0]!.id];
    const res = await submit(surveyId, person.token, { versionId: loaded.versionId, answers: broken });
    expect(res.status).toBe(400);

    const draft = await api(`/api/surveys/${surveyId}/draft`, person.token);
    expect(draft.body, "черновик удалён неудачной сдачей").not.toBeNull();
    expect(draft.body.answers.length).toBe(2);
  });
});

describe("отказы по-прежнему оставляют след", () => {
  test("отказ requireStaff — в журнале после отката", async () => {
    const person = await makeUser("user", `staff-denied-${tag()}@test.dev`);
    const res = await api(`/api/norms/surveys/${surveyInA}/apply`, person.token, {
      method: "POST",
      body: JSON.stringify({ scaleCodes: ["X"] }),
    });
    expect(res.status).toBe(403);
    expect((await denials(person.id, "staff_required")).length).toBe(1);
  });

  test("неверный пароль при выключении второго фактора считается в лимит попыток", async () => {
    const email = `mfa-off-${tag()}@test.dev`;
    const person = await makeUser("user", email);
    const res = await api("/api/auth/mfa/disable", person.token, {
      method: "POST",
      body: JSON.stringify({ password: "не-тот-пароль", code: "000000" }),
    });
    expect(res.status).toBe(401);
    expect(await marked(email), "неудача не посчитана — перебор через «выключить» бесплатен").toBe(1);
    const journal = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.actorId, person.id), eq(auditLog.action, "mfa.disable")));
    expect(journal.map((r) => r.outcome)).toEqual(["denied"]);
  });

  test("под боевой ролью базы: отказы до транзакции и внутри неё — в журнале", async () => {
    const t = tag();
    const readOnly = await makeUser("user", `ro-${t}@test.dev`, { readOnly: true });
    const plain = await makeUser("user", `plain-${t}@test.dev`);
    const out = await underAppRole<{ ro: number; staff: number }>(`
      const login = async (email) => {
        const res = await app.request("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: "secret12345" }),
        });
        return { Authorization: "Bearer " + (await res.json()).token, "Content-Type": "application/json" };
      };
      const ro = await app.request(${JSON.stringify(`/api/surveys/${surveyInA}/draft`)}, {
        method: "PUT",
        headers: await login(${JSON.stringify(`ro-${t}@test.dev`)}),
        body: JSON.stringify({ answers: [], startedAt: new Date().toISOString(), durationMs: 0 }),
      });
      out.ro = ro.status;
      const staff = await app.request(${JSON.stringify(`/api/norms/surveys/${surveyInA}/apply`)}, {
        method: "POST",
        headers: await login(${JSON.stringify(`plain-${t}@test.dev`)}),
        body: JSON.stringify({ scaleCodes: ["X"] }),
      });
      out.staff = staff.status;
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive).toBe(true);
    expect(out.ro).toBe(403);
    expect(out.staff).toBe(403);
    // до транзакции запроса: без контекста политика журнала строку не пропускала
    expect((await denials(readOnly.id, "read_only_account")).length).toBe(1);
    // внутри транзакции запроса: откат, затем повтор системной ролью
    expect((await denials(plain.id, "staff_required")).length).toBe(1);
  }, 60_000);
});

/* ─────────── 2. прохождение закреплено за версией ─────────── */

describe("версия прохождения", () => {
  test("начато на v1, опубликована v2, сдача считается по v1", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `pin-${tag()}@test.dev`, { sex: "male", birthDate: "1990-03-03" });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;

    // пока человек отвечал, методику обновили: «Так» весит уже 5, а не 1
    const v2Id = await createVersion(surveyId, content(5), adminA.id, "v2");
    expect(v2Id).not.toBe(v1.versionId);

    const res = await submit(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const row = await db.query.responses.findFirst({ where: eq(responses.id, res.body.id) });
    expect(row!.versionId).toBe(v1.versionId);
    const [score] = await db.select().from(responseScores).where(eq(responseScores.responseId, res.body.id));
    expect(score!.rawScore, "посчитано по весам новой версии").toBe(2);
  });

  test("старый клиент без versionId: версия выводится по пунктам, с пометкой в журнале", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `pin-old-${tag()}@test.dev`, { sex: "male", birthDate: "1990-03-03" });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    await createVersion(surveyId, content(5), adminA.id, "v2");

    const res = await submit(surveyId, person.token, { answers: yesAnswers(v1) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await db.query.responses.findFirst({ where: eq(responses.id, res.body.id) });
    expect(row!.versionId).toBe(v1.versionId);

    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "response.submit"), eq(auditLog.resourceId, res.body.id)));
    expect((entry!.details as { versionSource?: string }).versionSource).toBe("inferred");
    // отброшенные движком ответы на скрытые пункты — числом в том же журнале (участок engine)
    expect((entry!.details as { hiddenDropped?: number }).hiddenDropped).toBe(0);
  });

  test("версия чужой методики — 400 с понятной причиной, прохождения нет", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `pin-foreign-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const [foreign] = await db
      .select({ id: surveyVersions.id })
      .from(surveyVersions)
      .where(eq(surveyVersions.surveyId, surveyInA))
      .limit(1);

    const res = await submit(surveyId, person.token, { versionId: foreign!.id, answers: yesAnswers(v1) });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("версії");
    const rows = await db.select().from(responses).where(eq(responses.userId, person.id));
    expect(rows).toEqual([]);
  });

  test("черновик помнит свою версию и хранит её ответы", async () => {
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `pin-draft-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    await createVersion(surveyId, content(5), adminA.id, "v2");

    const saved = await saveDraft(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(saved.status).toBe(200);
    expect(saved.body.answers).toBe(2);

    const draft = await api(`/api/surveys/${surveyId}/draft`, person.token);
    expect(draft.body.versionId).toBe(v1.versionId);
    expect(draft.body.answers.length, "ответы v1 отброшены как «чужие пункты» v2").toBe(2);
  });
});

/* ─────────── 3. ограничение доступа — и при сдаче ─────────── */

describe("закрытая методика", () => {
  test("после отзыва назначения сдача и черновик — 403 со строкой журнала", async () => {
    const surveyId = await makeSurvey("restricted");
    const person = await makeUser("user", `revoked-${tag()}@test.dev`);
    await db.insert(surveyAccess).values({ surveyId, userId: person.id, grantedBy: adminA.id });

    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    expect((await saveDraft(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) })).status).toBe(200);

    // назначение отозвали, а вопросы у человека остались на экране
    await db.delete(surveyAccess).where(and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, person.id)));

    const res = await submit(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status).toBe(403);
    const completed = await db
      .select()
      .from(responses)
      .where(and(eq(responses.userId, person.id), eq(responses.status, "completed")));
    expect(completed).toEqual([]);
    expect((await saveDraft(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) })).status).toBe(403);
    expect((await denials(person.id, "survey_grant_missing")).length).toBe(2);
  });

  test("истёкшее назначение — тоже 403", async () => {
    const surveyId = await makeSurvey("restricted");
    const person = await makeUser("user", `expired-${tag()}@test.dev`);
    await db.insert(surveyAccess).values({ surveyId, userId: person.id, grantedBy: adminA.id });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    await db
      .update(surveyAccess)
      .set({ expiresAt: new Date(Date.now() - 60_000).toISOString() })
      .where(and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, person.id)));

    const res = await submit(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status).toBe(403);
  });

  test("с действующим назначением сдаётся как прежде", async () => {
    const surveyId = await makeSurvey("restricted");
    const person = await makeUser("user", `granted-${tag()}@test.dev`);
    await db.insert(surveyAccess).values({ surveyId, userId: person.id, grantedBy: adminA.id });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const res = await submit(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

/* ─────────── 4. заполнение за пациента — только своего ─────────── */

describe("заполнение за пациента", () => {
  test("пациент вне зоны сотрудника — 403, строка журнала, результата нет", async () => {
    const surveyId = await makeSurvey();
    const stranger = await makeUser("user", `stranger-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, adminA.token)).body;

    const res = await submit(surveyId, adminA.token, { onBehalfOf: stranger.id, versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status).toBe(403);
    const rows = await db.select().from(responses).where(eq(responses.userId, stranger.id));
    expect(rows, "чужому пациенту вписан результат").toEqual([]);

    const journal = (await denials(adminA.id, "patient_out_of_scope")).filter((r) => r.resourceId === stranger.id);
    expect(journal.length).toBe(1);

    // и зона от попытки не расширилась
    const card = await api(`/api/patients/${stranger.id}/card`, adminA.token);
    expect(card.status).not.toBe(200);
  });

  test("несуществующий пациент — тот же отказ, что и чужой", async () => {
    const surveyId = await makeSurvey();
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, adminA.token)).body;
    const res = await submit(surveyId, adminA.token, { onBehalfOf: crypto.randomUUID(), versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status).toBe(403);
  });

  test("свой пациент — заполняется как прежде", async () => {
    const surveyId = await makeSurvey();
    const own = await makeUser("user", `own-${tag()}@test.dev`, { sex: "female", birthDate: "1988-08-08" });
    // своим его делает назначение методики группы
    await db.insert(surveyAccess).values({ surveyId, userId: own.id, grantedBy: adminA.id });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, adminA.token)).body;
    const res = await submit(surveyId, adminA.token, { onBehalfOf: own.id, versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = await db.query.responses.findFirst({ where: eq(responses.id, res.body.id) });
    expect(row!.userId).toBe(own.id);
  });

  test("без права administer — 403 по праву, строка журнала, результата нет; с правом — как прежде (CR-069)", async () => {
    /*
     * Право «заполнять методику за пациента» есть в справочнике, но до волны
     * 18 его не проверял никто: сотрудник с исключением administer: revoke
     * сдавал за пациента → 201. Мутация: убрать проверку hasPermission в
     * ветке onBehalfOf — первое ожидание падает.
     */
    const surveyId = await makeSurvey();
    const own = await makeUser("user", `own-noadm-${tag()}@test.dev`, { sex: "male", birthDate: "1979-09-09" });
    await db.insert(surveyAccess).values({ surveyId, userId: own.id, grantedBy: adminA.id });
    const nurse = await makeUser("admin", `nurse-${tag()}@test.dev`);
    await db.insert(groupAdmins).values({ groupId: groupA, userId: nurse.id, addedBy: root.id });
    await db.insert(permissionExceptions).values({
      id: crypto.randomUUID(),
      userId: nurse.id,
      permission: "administer",
      mode: "revoke",
      reason: "Проверка права заполнения за пациента",
      grantedBy: root.id,
    });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, nurse.token)).body;
    const body = { onBehalfOf: own.id, versionId: v1.versionId, answers: yesAnswers(v1) };

    const denied = await submit(surveyId, nurse.token, body);
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(denied.body.scores).toBeUndefined();
    expect(await db.select().from(responses).where(eq(responses.userId, own.id))).toEqual([]);
    const journal = (await denials(nurse.id, "permission_required")).filter(
      (r) => (r.details as { permission?: string }).permission === "administer",
    );
    expect(journal.length).toBe(1);
    // на себя сдать может — право про других, не про себя
    const self = await submit(surveyId, nurse.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(self.status, JSON.stringify(self.body)).toBe(201);

    // положительный контроль: исключение снято — заполнение за пациента проходит
    await db.update(permissionExceptions).set({ revokedAt: new Date().toISOString() } as never).where(eq(permissionExceptions.userId, nurse.id));
    const allowed = await submit(surveyId, nurse.token, body);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(201);
    expect((await db.query.responses.findFirst({ where: eq(responses.id, allowed.body.id) }))!.userId).toBe(own.id);
  });

  test("суперадмину зона — все; несуществующий по-прежнему «не найден»", async () => {
    const surveyId = await makeSurvey();
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, root.token)).body;
    const res = await submit(surveyId, root.token, { onBehalfOf: crypto.randomUUID(), versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status).toBe(404);
  });
});

/* ─────────── повтор попытки отдаёт только своё ─────────── */

describe("повтор по clientRequestId", () => {
  test("чужой человек с тем же идентификатором — 409 без чужого прохождения, строка журнала", async () => {
    const surveyId = await makeSurvey();
    const owner = await makeUser("user", `replay-own-${tag()}@test.dev`, { sex: "male", birthDate: "1990-01-01" });
    const other = await makeUser("user", `replay-other-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, owner.token)).body;
    const clientRequestId = crypto.randomUUID();
    const first = await submit(surveyId, owner.token, { clientRequestId, versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(first.status).toBe(201);

    // тот же человек — обычный повтор офлайн-очереди, сохранённое прохождение
    const again = await submit(surveyId, owner.token, { clientRequestId, versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const foreign = await submit(surveyId, other.token, { clientRequestId, versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(foreign.status, "чужое прохождение отдано по одному идентификатору").toBe(409);
    expect(JSON.stringify(foreign.body)).not.toContain(first.body.id);
    expect(foreign.body.scores).toBeUndefined();
    expect((await denials(other.id, "client_request_foreign")).length).toBe(1);
    // и своего не завёл: отказ, а не второе прохождение под тем же id
    const mine = await db.select().from(responses).where(eq(responses.userId, other.id));
    expect(mine).toEqual([]);
  });

  test("тот же человек, но другая методика — тоже отказ", async () => {
    const surveyId = await makeSurvey();
    const otherSurvey = await makeSurvey();
    const person = await makeUser("user", `replay-survey-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const clientRequestId = crypto.randomUUID();
    expect((await submit(surveyId, person.token, { clientRequestId, versionId: v1.versionId, answers: yesAnswers(v1) })).status).toBe(201);

    const w1 = (await api<Loaded>(`/api/surveys/${otherSurvey}`, person.token)).body;
    const res = await submit(otherSurvey, person.token, { clientRequestId, versionId: w1.versionId, answers: yesAnswers(w1) });
    expect(res.status).toBe(409);
  });

  test("за пациента: повтор своего — прохождение, коллеги с тем же id — отказ", async () => {
    const surveyId = await makeSurvey();
    const patientOf = await makeUser("user", `replay-patient-${tag()}@test.dev`, { sex: "female", birthDate: "1985-05-05" });
    await db.insert(surveyAccess).values({ surveyId, userId: patientOf.id, grantedBy: adminA.id });
    const colleague = await makeUser("admin", `replay-colleague-${tag()}@test.dev`);
    await db.insert(groupAdmins).values({ groupId: groupA, userId: colleague.id, addedBy: root.id });

    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, adminA.token)).body;
    const clientRequestId = crypto.randomUUID();
    const body = { clientRequestId, onBehalfOf: patientOf.id, versionId: v1.versionId, answers: yesAnswers(v1) };
    const first = await submit(surveyId, adminA.token, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const again = await submit(surveyId, adminA.token, body);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);

    const byColleague = await submit(surveyId, colleague.token, body);
    expect(byColleague.status).toBe(409);
  });
});

/* ─────────── повтор отдаёт тот же результат, что первая сдача ─────────── */

/**
 * Один сериализатор результата для первой сдачи и повтора (CR-105).
 *
 * Повтор по clientRequestId отдавал строки response_scores как есть: без
 * scaleCode, scaleTitle, kind, correctedScore и band — вместо полосы плоские
 * bandLabel/severity. Экран результата мобилки читает scaleTitle и
 * band.severity/label/description: при повторе из очереди исчезали имя
 * шкалы и интерпретация.
 */
describe("повтор по clientRequestId: формат результата", () => {
  /** Шкала с полосами, у которых есть описание и рекомендация — то, что теряется при повторе */
  function bandedContent(yesScore: number) {
    const base = content(yesScore);
    return {
      ...base,
      scales: base.scales.map((s) => ({
        ...s,
        bands: [
          {
            minScore: 0,
            maxScore: 1,
            label: { uk: "Низький", ru: "Низкий" },
            severity: "none" as const,
            description: { uk: "У межах норми", ru: "В пределах нормы" },
            grade: 1,
            recommendation: null,
          },
          {
            minScore: 2,
            maxScore: 99,
            label: { uk: "Високий", ru: "Высокий" },
            severity: "severe" as const,
            description: { uk: "Виражені ознаки", ru: "Выраженные признаки" },
            grade: 3,
            recommendation: { uk: "Консультація фахівця", ru: "Консультация специалиста" },
          },
        ],
      })),
    };
  }

  async function bandedSurvey(showResultsToPatient: boolean): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(surveys).values({
      id,
      groupId: groupA,
      title: { uk: `Повтор ${tag()}`, ru: "Повтор" },
      administration: "self",
      status: "published",
      publishedAt: new Date().toISOString(),
      visibility: "public",
      scoringEnabled: true,
      allowRetake: true,
      showResultsToPatient,
      createdBy: adminA.id,
    } as never);
    await createVersion(id, createSurveySchema.parse(bandedContent(1)), adminA.id, "v1");
    return id;
  }

  const noDuplicate = (body: Record<string, unknown>) => {
    const { duplicate: _d, cascade: _c, ...rest } = body;
    return rest;
  };

  test("пациент, которому показывают результат: повтор — тот же ScoreResult с названием и интерпретацией", async () => {
    const surveyId = await bandedSurvey(true);
    const person = await makeUser("user", `replay-format-${tag()}@test.dev`, { sex: "male", birthDate: "1990-01-01" });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const clientRequestId = crypto.randomUUID();
    const body = { clientRequestId, versionId: v1.versionId, answers: yesAnswers(v1) };

    const first = await submit(surveyId, person.token, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.scores).toHaveLength(1);
    expect(first.body.scores[0].scaleTitle).toBe("Сума");
    expect(first.body.scores[0].band).toMatchObject({ label: "Високий", severity: "severe", description: "Виражені ознаки" });

    const again = await submit(surveyId, person.token, body);
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    // та же форма и те же значения: не строки таблицы, а ScoreResult по сохранённой версии
    expect(noDuplicate(again.body)).toEqual(noDuplicate(first.body));
  });

  test("результат не показывают — пусто в обоих ответах; специалист за пациента видит полный в обоих", async () => {
    const surveyId = await bandedSurvey(false);
    const person = await makeUser("user", `replay-hidden-${tag()}@test.dev`, { sex: "female", birthDate: "1991-01-01" });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const hidden = { clientRequestId: crypto.randomUUID(), versionId: v1.versionId, answers: yesAnswers(v1) };
    const first = await submit(surveyId, person.token, hidden);
    expect(first.status).toBe(201);
    expect(first.body.scores).toEqual([]);
    const again = await submit(surveyId, person.token, hidden);
    expect(again.status).toBe(200);
    expect(noDuplicate(again.body)).toEqual(noDuplicate(first.body));

    const patientOf = await makeUser("user", `replay-staff-${tag()}@test.dev`, { sex: "male", birthDate: "1980-01-01" });
    await db.insert(surveyAccess).values({ surveyId, userId: patientOf.id, grantedBy: adminA.id });
    const byStaff = { clientRequestId: crypto.randomUUID(), onBehalfOf: patientOf.id, versionId: v1.versionId, answers: yesAnswers(v1) };
    const staffFirst = await submit(surveyId, adminA.token, byStaff);
    expect(staffFirst.status, JSON.stringify(staffFirst.body)).toBe(201);
    expect(staffFirst.body.scores[0].band.recommendation).toBe("Консультація фахівця");
    const staffAgain = await submit(surveyId, adminA.token, byStaff);
    expect(staffAgain.status).toBe(200);
    expect(noDuplicate(staffAgain.body)).toEqual(noDuplicate(staffFirst.body));
  });

  test("после новой редакции повтор считается по той версии, которую проходили", async () => {
    const surveyId = await bandedSurvey(true);
    const person = await makeUser("user", `replay-version-${tag()}@test.dev`, { sex: "male", birthDate: "1992-01-01" });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const body = { clientRequestId: crypto.randomUUID(), versionId: v1.versionId, answers: yesAnswers(v1) };
    const first = await submit(surveyId, person.token, body);
    expect(first.status).toBe(201);

    // новая редакция: шкала переименована, полосы перерисованы — у повтора ничего из этого быть не должно
    const next = bandedContent(5);
    const renamed = {
      ...next,
      scales: next.scales.map((sc) => ({
        ...sc,
        title: { uk: "Нова сума", ru: "Новая сумма" },
        bands: [{ minScore: 0, maxScore: 99, label: { uk: "Інакше", ru: "Иначе" }, severity: "mild" }],
      })),
    };
    await createVersion(surveyId, createSurveySchema.parse(renamed), adminA.id, "v2");

    const again = await submit(surveyId, person.token, body);
    expect(again.status).toBe(200);
    expect(noDuplicate(again.body)).toEqual(noDuplicate(first.body));
  });
});

/* ─────────── «от имени» и «только просмотр» — только чтение, и держит это база ─────────── */

async function impersonate(targetId: string): Promise<{ token: string; sessionId: string }> {
  const start = await api(`/api/ops/people/impersonate/${targetId}`, root.token, {
    method: "POST",
    body: JSON.stringify({ reason: "Проверка режима только чтения" }),
  });
  if (start.status !== 201) throw new Error(`вход «от имени» не выдан: ${start.status} ${JSON.stringify(start.body)}`);
  return { token: start.body.token, sessionId: start.body.sessionId };
}

describe("транзакция «только чтение»", () => {
  test("GET, который пишет, под входом «от имени» падает в базе, и записи нет", async () => {
    const person = await makeUser("user", `ro-imp-${tag()}@test.dev`);
    const { token, sessionId } = await impersonate(person.id);
    const email = `imp-${tag()}@probe`;
    const res = await probe.request(`/write/${email}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status, "запись прошла мимо «только чтение»").toBe(500);
    expect(await marked(email)).toBe(0);
    await api(`/api/ops/people/impersonate/${sessionId}/end`, root.token, { method: "POST" });
  });

  test("то же для учётки «только просмотр»", async () => {
    const viewer = await makeUser("user", `ro-flag-${tag()}@test.dev`, { readOnly: true });
    const email = `ro-${tag()}@probe`;
    const res = await probe.request(`/write/${email}`, { headers: { Authorization: `Bearer ${viewer.token}` } });
    expect(res.status).toBe(500);
    expect(await marked(email)).toBe(0);
  });

  test("обычная учётка тем же GET пишет — дело не в маршруте", async () => {
    const person = await makeUser("user", `rw-${tag()}@test.dev`);
    const email = `rw-${tag()}@probe`;
    const res = await probe.request(`/write/${email}`, { headers: { Authorization: `Bearer ${person.token}` } });
    expect(res.status).toBe(200);
    expect(await marked(email)).toBe(1);
  });

  test("под боевой ролью базы: просмотр «от имени» оставляет impersonation.view", async () => {
    const person = await makeUser("user", `imp-view-${tag()}@test.dev`);
    const { token, sessionId } = await impersonate(person.id);
    const out = await underAppRole<{ me: number }>(`
      const me = await app.request("/api/auth/me", { headers: { Authorization: ${JSON.stringify(`Bearer ${token}`)} } });
      out.me = me.status;
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive).toBe(true);
    expect(out.me).toBe(200);
    const views = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "impersonation.view"), sql`${auditLog.details}->>'impersonation' = ${sessionId}`));
    expect(views.length, "след просмотра «от имени» потерян под боевой ролью").toBeGreaterThan(0);
    await api(`/api/ops/people/impersonate/${sessionId}/end`, root.token, { method: "POST" });
  }, 60_000);
});

/* ─────────── тревоги автосохранения переживают сдачу ─────────── */

/** Методика, где «Так» на первом пункте — критический ответ */
async function makeRiskySurvey(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(surveys).values({
    id,
    groupId: groupA,
    title: { uk: `Ризик ${tag()}`, ru: "Риск" },
    administration: "self",
    status: "published",
    publishedAt: new Date().toISOString(),
    visibility: "public",
    scoringEnabled: true,
    allowRetake: true,
    createdBy: adminA.id,
  } as never);
  const draft = content(1);
  draft.questions[0]!.options[0] = {
    ...draft.questions[0]!.options[0]!,
    riskFlag: true,
    riskLabel: { uk: "Думки про небажання жити", ru: "Мысли о нежелании жить" },
    riskSeverity: "moderate",
  };
  await createVersion(id, draft, adminA.id, "v1");
  return id;
}

describe("тревоги черновика при сдаче", () => {
  test("автосохранение подняло тревогу → сдача → тревога, случай и направление на месте", async () => {
    const surveyId = await makeRiskySurvey();
    const person = await makeUser("user", `draft-alert-${tag()}@test.dev`, { sex: "male", birthDate: "1990-01-01" });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;

    const saved = await saveDraft(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1).slice(0, 1) });
    expect(saved.status).toBe(200);
    const [early] = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, saved.body.id));
    expect(early, "автосохранение не подняло тревогу").toBeTruthy();

    // дежурный успел выписать направление по ранней тревоге
    const referralId = crypto.randomUUID();
    await db.insert(referrals).values({
      id: referralId,
      userId: person.id,
      responseId: saved.body.id,
      alertId: early!.id,
      destination: "psychiatrist",
      urgency: "urgent",
      createdBy: adminA.id,
    } as never);

    const res = await submit(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const [kept] = await db.select().from(riskAlerts).where(eq(riskAlerts.id, early!.id));
    expect(kept, "сдача унесла тревогу автосохранения").toBeTruthy();
    expect(kept!.responseId).toBe(res.body.id);
    // один сигнал на пункт: повторный от сдачи слит с ранним, а не лежит рядом
    const onFinal = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, res.body.id));
    expect(onFinal.filter((a) => a.questionId === early!.questionId).length).toBe(1);

    const [caseRow] = await db.select().from(alertCases).where(eq(alertCases.id, kept!.caseId!));
    expect(caseRow, "случай без сигнала").toBeTruthy();
    const [ref] = await db.select().from(referrals).where(eq(referrals.id, referralId));
    expect(ref!.alertId, "направление потеряло тревогу").toBe(early!.id);
    expect(ref!.responseId).toBe(res.body.id);
    // черновика больше нет — он стал сдачей
    const draftsLeft = await db
      .select()
      .from(responses)
      .where(and(eq(responses.userId, person.id), eq(responses.status, "in_progress")));
    expect(draftsLeft).toEqual([]);
  });

  test("под боевой ролью базы: тревога черновика переезжает на сдачу", async () => {
    const surveyId = await makeRiskySurvey();
    const email = `draft-alert-rls-${tag()}@test.dev`;
    const person = await makeUser("user", email, { sex: "female", birthDate: "1992-02-02" });
    const out = await underAppRole<{ draft: number; submit: number; draftId: string; finalId: string }>(`
      const login = await app.request("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: ${JSON.stringify(email)}, password: "secret12345" }),
      });
      const auth = { Authorization: "Bearer " + (await login.json()).token, "Content-Type": "application/json" };
      const survey = await (await app.request(${JSON.stringify(`/api/surveys/${surveyId}`)}, { headers: auth })).json();
      const answers = survey.questions.map((q) => ({ questionId: q.id, optionIds: [q.options[0].id], durationMs: 1000, changeCount: 0, visitCount: 1 }));
      const common = { startedAt: new Date(Date.now() - 60000).toISOString(), durationMs: 60000, versionId: survey.versionId };
      const draft = await app.request(${JSON.stringify(`/api/surveys/${surveyId}/draft`)}, {
        method: "PUT", headers: auth, body: JSON.stringify({ ...common, answers: answers.slice(0, 1) }),
      });
      out.draft = draft.status;
      out.draftId = (await draft.json()).id;
      const submit = await app.request(${JSON.stringify(`/api/surveys/${surveyId}/responses`)}, {
        method: "POST", headers: auth, body: JSON.stringify({ ...common, events: [], answers }),
      });
      out.submit = submit.status;
      out.finalId = (await submit.json()).id;
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive).toBe(true);
    expect(out.draft).toBe(200);
    expect(out.submit).toBe(201);
    const alerts = await db.select().from(riskAlerts).where(eq(riskAlerts.userId, person.id));
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.responseId).toBe(out.finalId!);
  }, 60_000);

  test("удалить прохождение с тревогой база не даёт, а удаление методики целиком проходит", async () => {
    const surveyId = await makeRiskySurvey();
    const person = await makeUser("user", `restrict-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const res = await submit(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status).toBe(201);

    const refused = await db
      .delete(responses)
      .where(eq(responses.id, res.body.id))
      .then(
        () => false,
        () => true,
      );
    expect(refused, "прохождение с тревогой удалилось вместе с ней").toBe(true);
    // survey:purge — тревоги уходят каскадом по методике в том же операторе
    await db.delete(surveys).where(eq(surveys.id, surveyId));
    expect(await db.select().from(riskAlerts).where(eq(riskAlerts.surveyId, surveyId))).toEqual([]);
  });
});

/* ─────────── согласие: условие сдачи и принятие показанной редакции ─────────── */

describe("информированное согласие на сервере", () => {
  /* текст согласия общий на всю базу: после блока его не остаётся (см. access.test.ts) */
  afterAll(async () => {
    await db.delete(consents);
    await db.delete(consentTexts);
  });

  const putText = (uk: string) =>
    api("/api/consents/text", root.token, { method: "PUT", body: JSON.stringify({ body: { uk, ru: uk } }) });
  const accept = (token: string, textId?: string) =>
    api("/api/consents/me/accept", token, { method: "POST", body: JSON.stringify(textId ? { textId } : {}) });

  test("без принятой редакции сдача и черновик — 403 consentRequired; принял — проходит; отозвал — снова нет", async () => {
    expect((await putText(`Згода на обстеження, редакція ${tag()}`)).status).toBe(200);
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `consent-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const body = { versionId: v1.versionId, answers: yesAnswers(v1) };

    const draft = await saveDraft(surveyId, person.token, body);
    expect(draft.status).toBe(403);
    expect(draft.body.error).toContain("згоду");
    expect((await submit(surveyId, person.token, body)).status).toBe(403);
    expect((await denials(person.id, "consent_missing")).length).toBe(2);

    const status = await api("/api/consents/me", person.token);
    expect((await accept(person.token, status.body.textId)).status).toBe(200);
    expect((await submit(surveyId, person.token, body)).status).toBe(201);

    // отзыв согласия (мобильный «не погоджуюся» снимает принятие действующей редакции)
    await db.delete(consents).where(eq(consents.userId, person.id));
    const after = await submit(surveyId, person.token, body);
    expect(after.status, "сдача прошла после отзыва согласия").toBe(403);
  });

  test("новая редакция требует согласия заново — и сдача ждёт его", async () => {
    await putText(`Перша редакція ${tag()}`);
    const surveyId = await makeSurvey();
    const person = await makeUser("user", `consent-new-${tag()}@test.dev`);
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, person.token)).body;
    const first = await api("/api/consents/me", person.token);
    expect((await accept(person.token, first.body.textId)).status).toBe(200);

    await putText(`Нова редакція ${tag()}`);
    expect((await submit(surveyId, person.token, { versionId: v1.versionId, answers: yesAnswers(v1) })).status).toBe(403);
  });

  test("принятие показанной редакции: устаревшая — 409 и не принято, действующая — принято", async () => {
    await putText(`Редакція, яку показали ${tag()}`);
    const person = await makeUser("user", `consent-stale-${tag()}@test.dev`);
    const shown = await api("/api/consents/me", person.token);
    // пока человек читал, текст обновили
    await putText(`Редакція, якої він не бачив ${tag()}`);

    const stale = await accept(person.token, shown.body.textId);
    expect(stale.status).toBe(409);
    const status = await api("/api/consents/me", person.token);
    expect(status.body.accepted, "согласие записалось на текст, которого человек не видел").toBe(false);
    expect(status.body.text).toContain("якої він не бачив");

    expect((await accept(person.token, status.body.textId)).status).toBe(200);
    expect((await api("/api/consents/me", person.token)).body.accepted).toBe(true);
  });

  test("старый клиент без textId принимает, как раньше, — с пометкой в журнале", async () => {
    await putText(`Редакція для старого клієнта ${tag()}`);
    const person = await makeUser("user", `consent-legacy-${tag()}@test.dev`);
    expect((await accept(person.token)).status).toBe(200);
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "consent.accept"), eq(auditLog.subjectUserId, person.id)));
    expect((entry!.details as { shownTextId: string | null }).shownTextId).toBeNull();
  });

  test("специалист заполняет за своего пациента без его согласия в системе — принимается", async () => {
    await putText(`Редакція ${tag()}`);
    const surveyId = await makeSurvey();
    const own = await makeUser("user", `consent-onbehalf-${tag()}@test.dev`, { sex: "male", birthDate: "1980-01-01" });
    await db.insert(surveyAccess).values({ surveyId, userId: own.id, grantedBy: adminA.id });
    const v1 = (await api<Loaded>(`/api/surveys/${surveyId}`, adminA.token)).body;
    const res = await submit(surveyId, adminA.token, { onBehalfOf: own.id, versionId: v1.versionId, answers: yesAnswers(v1) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

/* строки проб в login_attempts — свои, с почтой-меткой; уходят после файла */
afterAll(async () => {
  await db.execute(sql`delete from login_attempts where email like '%@probe'`);
});
