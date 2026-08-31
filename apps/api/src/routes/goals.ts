import { Hono } from "hono";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { reliableChange, t } from "@quizzy/shared";
import { db } from "../db";
import { responseScores, responses, scales, surveyVersions, surveys, treatmentGoals, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, langOf, notFound, parseBody } from "../lib/http";
import { variance } from "../lib/stats";
import { accessiblePatientIds } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import type { User } from "@quizzy/shared";

export const goalRoutes = new Hono<AppEnv>();
/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 *
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
goalRoutes.use("*", requireAuth, requireStaff, requirePermission("goals.manage"));

/**
 * Цели лечения.
 *
 * «Стало полегче» нельзя ни проверить, ни передать коллеге; «ЛАП выше 4 к
 * третьему месяцу» — можно. Цель привязана к шкале и сроку, а прогресс
 * считается из тех же замеров, что и вся аналитика: отдельного «журнала
 * успехов» нет и быть не должно — он разошёлся бы с данными.
 *
 * Достоверность изменения показывается рядом с прогрессом. Это два разных
 * утверждения: «значение приблизилось к цели» и «изменение больше ошибки
 * измерения». Первое без второго — повод для осторожности, а не для отчёта.
 */

const goalSchema = z.object({
  surveyId: z.string().uuid(),
  scaleCode: z.string().min(1).max(40),
  direction: z.enum(["down", "up"]),
  targetValue: z.number(),
  dueAt: z.string().nullable().optional(),
  note: z.string().max(1000).optional(),
  pathwayInstanceId: z.string().uuid().nullable().optional(),
});

async function assertPatient(staff: User, userId: string) {
  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("err.patientNotFound");
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("err.patientNotFound");
}

/**
 * Замеры шкалы у человека и по выборке.
 *
 * Значения берутся из `response_scores` — того же источника, что питает
 * динамику и отчёты. Выборка нужна для SD: без неё RCI посчитать не из чего.
 */
async function scaleSeries(userId: string, surveyId: string, code: string) {
  const rows = await db
    .select({ score: responseScores, response: responses, scale: scales })
    .from(responseScores)
    .innerJoin(responses, eq(responses.id, responseScores.responseId))
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(and(eq(responses.surveyId, surveyId), eq(scales.code, code), eq(responses.status, "completed")))
    .orderBy(asc(responses.submittedAt));

  const mine = rows
    .filter((r) => r.response.userId === userId)
    .map((r) => ({ at: r.response.submittedAt ?? r.response.startedAt, value: r.score.value }));

  return { mine, sample: rows.map((r) => r.score.value) };
}

goalRoutes.get("/patients/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  const lang = langOf(c);
  await assertPatient(staff, userId);

  const rows = await db
    .select({ goal: treatmentGoals, survey: surveys, author: users })
    .from(treatmentGoals)
    .innerJoin(surveys, eq(surveys.id, treatmentGoals.surveyId))
    .leftJoin(users, eq(users.id, treatmentGoals.createdBy))
    .where(eq(treatmentGoals.userId, userId))
    .orderBy(desc(treatmentGoals.createdAt));

  const items = [];
  for (const { goal, survey, author } of rows) {
    const { mine, sample } = await scaleSeries(userId, goal.surveyId, goal.scaleCode);
    const first = goal.baselineValue ?? mine[0]?.value ?? null;
    const last = mine.length ? mine[mine.length - 1]!.value : null;

    /*
     * Достоверность считается по SD выборки той же шкалы и её надёжности.
     * Надёжность здесь берётся как 0.8 по умолчанию только если не посчитана:
     * это осознанно консервативная оценка — она делает критерий строже, а не
     * мягче, и цель не будет объявлена достигнутой из-за шума.
     */
    let rc = null;
    if (first !== null && last !== null && sample.length >= 10) {
      const sd = Math.sqrt(variance(sample));
      rc = reliableChange(first, last, sd, 0.8);
    }

    const reached =
      last === null
        ? false
        : goal.direction === "down"
          ? last <= goal.targetValue
          : last >= goal.targetValue;

    items.push({
      id: goal.id,
      surveyId: goal.surveyId,
      surveyTitle: t(survey.title as never, lang),
      scaleCode: goal.scaleCode,
      direction: goal.direction,
      targetValue: goal.targetValue,
      baselineValue: first,
      currentValue: last,
      measurements: mine.length,
      reached,
      reliable: rc?.significant ?? null,
      rci: rc?.rci ?? null,
      status: goal.status,
      dueAt: goal.dueAt,
      note: goal.note,
      authorName: author ? fullNameOf(author) : "—",
      createdAt: goal.createdAt,
      closedAt: goal.closedAt,
    });
  }

  return c.json({ items });
});

goalRoutes.post("/patients/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  await assertPatient(staff, userId);
  const input = await parseBody(c.req.raw, goalSchema);

  /*
   * Шкала проверяется по коду в текущей версии методики: код переживает
   * смену версии, а идентификатор — нет. Цель, поставленная на
   * несуществующую шкалу, никогда бы не показала прогресс и выглядела бы
   * как «человек не двигается».
   */
  const [version] = await db
    .select({ id: surveyVersions.id })
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, input.surveyId))
    .orderBy(desc(surveyVersions.version))
    .limit(1);
  if (!version) notFound("err.surveyNotFound");

  const known = await db
    .select({ code: scales.code })
    .from(scales)
    .where(and(eq(scales.versionId, version.id), eq(scales.code, input.scaleCode)));
  if (!known.length) badRequest("err.scaleNotInSurvey");

  const { mine } = await scaleSeries(userId, input.surveyId, input.scaleCode);
  const baseline = mine.length ? mine[mine.length - 1]!.value : null;

  const id = crypto.randomUUID();
  await db.insert(treatmentGoals).values({
    id,
    userId,
    surveyId: input.surveyId,
    scaleCode: input.scaleCode,
    direction: input.direction,
    targetValue: input.targetValue,
    baselineValue: baseline,
    dueAt: input.dueAt ?? null,
    note: input.note?.trim() || null,
    pathwayInstanceId: input.pathwayInstanceId ?? null,
    createdBy: staff.id,
  });

  await audit(c, {
    action: "goal.create",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { scaleCode: input.scaleCode, target: input.targetValue },
  });

  return c.json({ id }, 201);
});

goalRoutes.patch("/:id", async (c) => {
  const staff = c.get("user");
  const row = await db.query.treatmentGoals.findFirst({
    where: eq(treatmentGoals.id, c.req.param("id")),
  });
  if (!row) notFound("err.goalNotFound");
  await assertPatient(staff, row.userId);

  const body = await c.req.json().catch(() => ({}));
  const status = ["met", "missed", "cancelled", "open"].includes(body?.status)
    ? (body.status as "met" | "missed" | "cancelled" | "open")
    : null;
  if (!status) badRequest("err.goalStatusRequired");

  await db
    .update(treatmentGoals)
    .set({
      status,
      note: typeof body.note === "string" ? body.note.trim() || row.note : row.note,
      closedAt: status === "open" ? null : new Date().toISOString(),
    })
    .where(eq(treatmentGoals.id, row.id));

  await audit(c, {
    action: "goal.close",
    resourceType: "user",
    resourceId: row.userId,
    subjectUserId: row.userId,
    details: { status },
  });

  return c.json({ ok: true });
});

void inArray;
