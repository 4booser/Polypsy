import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { t, type Administration } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { informantRequests, responseScores, responses, scales, surveys, users } from "../db/schema";
import { audit, auditSystem } from "../lib/audit";
import { badRequest, langOf, notFound, parseBody } from "../lib/http";
import { hashInviteToken, newInviteToken } from "../lib/invites";
import { accessiblePatientIds, assertSurveyAccess } from "../lib/scope";
import { persistSubmission } from "../lib/submission";
import { getSurvey } from "../lib/surveys";
import { isPast } from "../lib/time";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const informantRoutes = new Hono<AppEnv>();

/**
 * Мульти-информант: оценка не только самоотчётом.
 *
 * В военной психодиагностике расхождение между самоотчётом и наблюдением
 * командира — самостоятельный сигнал, а не помеха. Поэтому форма информанта
 * это отдельная методика, а не второй способ заполнить ту же: смешивать
 * самоотчёт и взгляд со стороны в одной выборке значит испортить и нормы, и
 * оценку надёжности.
 *
 * Имя информанта не хранится намеренно. Оценка командира не должна
 * превращаться в личное дело того, кто её дал: смысл несёт роль, а не
 * личность, а обещание анонимности — единственное, что делает такую оценку
 * честной.
 */

const ROLES = ["commander", "peer", "family", "clinician"] as const;

const createSchema = z.object({
  surveyId: z.string(),
  role: z.enum(ROLES),
  note: z.string().max(500).nullable().optional(),
  /** Сколько дней действует ссылка */
  days: z.number().int().min(1).max(60).default(14),
});

/* ── сотрудник: выдать ссылку ── */

informantRoutes.post("/patients/:userId", requireAuth, requireStaff, async (c) => {
  const staff = c.get("user");
  const patientId = c.req.param("userId");

  /*
   * Зона проверяется до разбора тела. Иначе на чужого пациента маршрут
   * отвечал бы «неверное тело запроса» вместо «такого нет» — то есть
   * подтверждал бы существование человека тем, что дошёл до валидации.
   */
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(patientId)) notFound("err.patientNotFound");

  const input = await parseBody(c.req.raw, createSchema);
  await assertSurveyAccess(staff, input.surveyId);

  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, input.surveyId) });
  if (!survey) notFound("err.surveyNotFound");
  if ((survey.administration as Administration) !== "informant") {
    /*
     * Иначе самоотчётная методика заполнялась бы посторонним человеком и
     * попадала в ту же выборку — норма и альфа поехали бы молча.
     */
    badRequest("err.notInformantForm");
  }
  if (survey.status !== "published") badRequest("err.surveyNotPublished");

  const raw = newInviteToken();
  const id = crypto.randomUUID();
  await db.insert(informantRequests).values({
    id,
    patientId,
    surveyId: input.surveyId,
    role: input.role,
    tokenHash: hashInviteToken(raw),
    note: input.note ?? null,
    createdBy: staff.id,
    expiresAt: new Date(Date.now() + input.days * 86_400_000).toISOString(),
  });

  await audit(c, {
    action: "informant.invite",
    resourceType: "informant_request",
    resourceId: id,
    subjectUserId: patientId,
    details: { role: input.role, surveyId: input.surveyId },
  });

  // сырой токен показывается один раз: в базе только отпечаток
  return c.json({ id, token: raw }, 201);
});

informantRoutes.get("/patients/:userId", requireAuth, requireStaff, async (c) => {
  const staff = c.get("user");
  const patientId = c.req.param("userId");

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(patientId)) notFound("err.patientNotFound");

  const rows = await db
    .select({ req: informantRequests, survey: surveys })
    .from(informantRequests)
    .innerJoin(surveys, eq(surveys.id, informantRequests.surveyId))
    .where(eq(informantRequests.patientId, patientId))
    .orderBy(desc(informantRequests.createdAt));

  const lang = langOf(c);
  return c.json({
    items: rows.map((r) => ({
      id: r.req.id,
      role: r.req.role,
      surveyId: r.req.surveyId,
      surveyTitle: t(r.survey.title as never, lang),
      note: r.req.note,
      expiresAt: r.req.expiresAt,
      usedAt: r.req.usedAt,
      revokedAt: r.req.revokedAt,
      responseId: r.req.responseId,
    })),
  });
});

informantRoutes.post("/:id/revoke", requireAuth, requireStaff, async (c) => {
  const staff = c.get("user");
  const id = c.req.param("id");

  const row = await db.query.informantRequests.findFirst({ where: eq(informantRequests.id, id) });
  if (!row) notFound("err.informantRequestNotFound");
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(row.patientId)) notFound("err.informantRequestNotFound");

  await db
    .update(informantRequests)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(informantRequests.id, id));

  await audit(c, {
    action: "informant.revoke",
    resourceType: "informant_request",
    resourceId: id,
    subjectUserId: row.patientId,
  });
  return c.json({ ok: true });
});

/* ── информант: без учётной записи, по ссылке ── */

/**
 * Поиск запроса по ссылке.
 *
 * Под системным контекстом: у информанта нет учётной записи, а значит и роли,
 * по которой сработала бы политика доступа. Права здесь заменяет сам токен —
 * он одноразовый и со сроком.
 */
async function findRequest(raw: string) {
  return systemContext(baseDb, async () => {
    const row = await db.query.informantRequests.findFirst({
      where: eq(informantRequests.tokenHash, hashInviteToken(raw)),
    });
    if (!row) return { row: null, reason: "unknown" as const };
    if (row.revokedAt) return { row: null, reason: "revoked" as const };
    if (row.usedAt) return { row: null, reason: "used" as const };
    if (isPast(row.expiresAt)) return { row: null, reason: "expired" as const };
    return { row, reason: null };
  });
}

informantRoutes.get("/form/:token", async (c) => {
  const { row, reason } = await findRequest(c.req.param("token"));
  if (!row) return c.json({ valid: false, reason });

  const lang = langOf(c);
  const survey = await systemContext(baseDb, () => getSurvey(row.surveyId, null, lang));
  if (!survey) return c.json({ valid: false, reason: "unknown" });

  /*
   * Имя пациента информанту не показывается по имени, а только по инициалам:
   * ссылку могут переслать не тому, и полное имя в такой ссылке — утечка,
   * которую никто не заметит.
   */
  const patient = await systemContext(baseDb, () =>
    db.query.users.findFirst({ where: eq(users.id, row.patientId) }),
  );
  const initials = patient
    ? `${patient.lastName?.[0] ?? ""}${patient.firstName?.[0] ?? ""}`.toUpperCase()
    : "—";

  return c.json({
    valid: true,
    role: row.role,
    note: row.note,
    about: initials,
    survey,
  });
});

const submitSchema = z.object({
  answers: z.array(z.record(z.string(), z.unknown())),
  startedAt: z.string(),
  durationMs: z.number().int().min(0).default(0),
});

informantRoutes.post("/form/:token", async (c) => {
  const { row } = await findRequest(c.req.param("token"));
  if (!row) notFound("err.informantLinkInvalid");

  const body = await c.req.json();
  const input = submitSchema.parse(body);

  const result = await systemContext(baseDb, async () => {
    const survey = await getSurvey(row.surveyId, null, langOf(c));
    if (!survey) notFound("err.surveyNotFound");

    /*
     * Пациент передаётся как «субъект» только ради проверок порядка батарей;
     * в само прохождение он не попадёт: persistSubmission не связывает форму
     * информанта с человеком (см. linkedUserId там же). Иначе оценка со
     * стороны легла бы в динамику пациента наравне с его самоотчётом.
     */
    const patient = await db.query.users.findFirst({ where: eq(users.id, row.patientId) });
    if (!patient) notFound("err.patientNotFound");

    const saved = await persistSubmission(
      survey,
      patient!,
      { ...input, events: [], status: "completed" } as never,
      { filledBySelf: false, lang: langOf(c) },
    );

    /*
     * Через прокси db, а не baseDb: внутри системного контекста он уходит в ту
     * же транзакцию, что и сама сдача. Обновление мимо транзакции падало на
     * внешнем ключе — прохождение ещё не было закоммичено.
     */
    await db
      .update(informantRequests)
      .set({ usedAt: new Date().toISOString(), responseId: saved.responseId })
      .where(eq(informantRequests.id, row.id));

    return saved;
  });

  await auditSystem({
    action: "informant.submit",
    resourceType: "response",
    resourceId: result.responseId,
    subjectUserId: row.patientId,
    details: { role: row.role, surveyId: row.surveyId },
  });

  // информанту результаты не показываются: он не адресат интерпретации
  return c.json({ ok: true }, 201);
});

/* ── сравнение перспектив ── */

/**
 * Самоотчёт против взгляда со стороны.
 *
 * Шкалы сопоставляются по коду — так же, как между версиями методики. Пары,
 * у которых кода нет с одной из сторон, не показываются: сравнивать «тревогу»
 * с «дисциплиной» нельзя, даже если очень хочется получить одну цифру.
 */
informantRoutes.get("/compare/:userId", requireAuth, requireStaff, async (c) => {
  const staff = c.get("user");
  const patientId = c.req.param("userId");
  const lang = langOf(c);

  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(patientId)) notFound("err.patientNotFound");

  const done = await db
    .select({ req: informantRequests })
    .from(informantRequests)
    .where(
      and(eq(informantRequests.patientId, patientId), isNull(informantRequests.revokedAt)),
    );
  const withResponse = done.filter((d) => d.req.responseId);
  if (!withResponse.length) return c.json({ items: [] });

  const selfScores = await db
    .select({ code: scales.code, title: scales.title, score: responseScores })
    .from(responseScores)
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .innerJoin(responses, eq(responses.id, responseScores.responseId))
    .where(and(eq(responses.userId, patientId), eq(responses.status, "completed")));

  // последний самоотчёт по каждому коду шкалы
  const selfByCode = new Map<string, { value: number; title: string }>();
  for (const row of selfScores) {
    selfByCode.set(row.code, { value: row.score.value, title: t(row.title as never, lang) });
  }

  const items: unknown[] = [];
  for (const { req } of withResponse) {
    const rows = await db
      .select({ code: scales.code, title: scales.title, score: responseScores })
      .from(responseScores)
      .innerJoin(scales, eq(scales.id, responseScores.scaleId))
      .where(eq(responseScores.responseId, req.responseId!));

    items.push({
      requestId: req.id,
      role: req.role,
      at: req.usedAt,
      scales: rows.map((r) => {
        const self = selfByCode.get(r.code) ?? null;
        return {
          code: r.code,
          title: t(r.title as never, lang),
          informant: r.score.value,
          self: self?.value ?? null,
          /*
           * Расхождение — только там, где есть обе стороны. Показать «−»
           * честнее, чем показать разницу с нулём: ноль здесь означал бы
           * «человек оценил себя на ноль», а он просто не отвечал.
           */
          gap: self ? Math.round((r.score.value - self.value) * 100) / 100 : null,
        };
      }),
    });
  }

  return c.json({ items });
});
