import { t } from "@quizzy/shared";
import { Hono } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  answerScore,
  ageAt,
  computeProfile,
  isAnswered,
  isQuestionVisible,
  submitResponseSchema,
  type Answer,
  type Question,
  type ScoreResult,
  type SurveyResponse,
} from "@quizzy/shared";
import { db } from "../db";
import { answerEvents, answers, riskAlerts, responseScores, responses, scales, surveys, users } from "../db/schema";
import { badRequest, conflict, forbidden, langOf, notFound, parseBody } from "../lib/http";
import { getSurvey, getSurveyForResponse } from "../lib/surveys";
import { detectRisks } from "../lib/risk";
import { persistSubmission } from "../lib/submission";
import { draftSchema } from "@quizzy/shared";
import { audit } from "../lib/audit";
import { assertBatteryOrder, closeCompletedBatteries } from "../lib/batteries";
import { assertSurveyAccess, isStaff } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const responseRoutes = new Hono<AppEnv>();

responseRoutes.use("*", requireAuth);

/** Отправка прохождения вместе с телеметрией по каждому вопросу */
responseRoutes.post("/surveys/:id/responses", async (c) => {
  const user = c.get("user");
  const surveyId = c.req.param("id");
  const input = await parseBody(c.req.raw, submitResponseSchema);

  /*
   * Идемпотентный повтор из офлайн-очереди: если попытка с этим id уже
   * закоммичена (сеть оборвалась ПОСЛЕ записи, клиент не узнал), возвращаем
   * существующее прохождение вместо создания дубля.
   */
  if (input.clientRequestId) {
    const existing = await db.query.responses.findFirst({
      where: eq(responses.clientRequestId, input.clientRequestId),
    });
    if (existing) {
      const scores = await db
        .select()
        .from(responseScores)
        .where(eq(responseScores.responseId, existing.id));
      return c.json(
        {
          id: existing.id,
          surveyId: existing.surveyId,
          submittedAt: existing.submittedAt,
          scores: [],
          reliable: true,
          warnings: [],
          safetyPlan: null,
          duplicate: true,
          storedScores: scores.length,
        },
        200,
      );
    }
  }

  const survey = await getSurvey(surveyId, null, langOf(c));
  if (!survey) notFound("Методика не найдена");
  if (survey.status !== "published") badRequest("Методика недоступна для прохождения");
  if (survey.administration !== "self" && !isStaff(user)) {
    forbidden("Методику заполняет специалист, а не респондент");
  }

  /*
   * Режим специалиста: клиницист заполняет методику за пациента.
   * Прохождение записывается на пациента, но в журнал уходит, кто его внёс —
   * иначе в карте появлялись бы данные без следа о том, кто их поставил.
   */
  let subjectId = user.id;
  if (input.onBehalfOf) {
    if (!isStaff(user)) forbidden("Заполнять за другого может только сотрудник");
    await assertSurveyAccess(user, surveyId);
    const subject = await db.query.users.findFirst({ where: eq(users.id, input.onBehalfOf) });
    if (!subject) notFound("Пациент не найден");
    if (subject.role !== "user") badRequest("Заполнять можно только за пациента");
    subjectId = subject.id;
  } else if (survey.administration === "clinician") {
    badRequest("Для этой методики нужно указать пациента, за которого она заполняется");
  }

  if (!survey.allowRetake && !survey.anonymous) {
    const existing = await db.query.responses.findFirst({
      where: and(
        eq(responses.surveyId, surveyId),
        eq(responses.userId, subjectId),
        eq(responses.status, "completed"),
      ),
    });
    if (existing) conflict("Вы уже проходили эту методику");
  }

  // незавершённый черновик того же пользователя убираем: иначе он остался бы
  // висеть как брошенное прохождение и портил статистику доходимости
  if (!survey.anonymous) {
    await db
      .delete(responses)
      .where(
        and(
          eq(responses.surveyId, surveyId),
          eq(responses.userId, subjectId),
          eq(responses.status, "in_progress"),
        ),
      );
  }

  const subject =
    subjectId === user.id
      ? { id: user.id, sex: user.sex, birthDate: user.birthDate }
      : (await db.query.users.findFirst({ where: eq(users.id, subjectId) }))!;

  const { responseId, submittedAt, scores, profile, risksTriggered } = await persistSubmission(
    survey,
    subject,
    input,
    { filledBySelf: subjectId === user.id },
  );

  await audit(c, {
    action: "response.submit",
    resourceType: "response",
    resourceId: responseId,
    subjectUserId: survey.anonymous ? null : subjectId,
    details: {
      surveyId,
      anonymous: survey.anonymous,
      durationMs: input.durationMs,
      events: input.events.length,
      // кто именно внёс данные, если заполнял специалист
      filledBy: subjectId === user.id ? null : user.email,
    },
  });

  return c.json(
    {
      id: responseId,
      surveyId,
      submittedAt,
      scores,
      reliable: profile.reliable,
      warnings: profile.warnings,
      // safety-план показывается тому, кто держит устройство, ровно в момент,
      // когда сработал критический пункт — и только самому обследуемому
      safetyPlan: risksTriggered > 0 && subjectId === user.id ? survey.safetyPlan : null,
    },
    201,
  );
});

/**
 * Автосохранение черновика.
 *
 * Идемпотентно: на пару (методика, пользователь) держится одно незавершённое
 * прохождение, каждое сохранение перезаписывает его ответы. Тревоги
 * поднимаются здесь же — в этом весь смысл раннего сохранения.
 */
responseRoutes.put("/surveys/:id/draft", async (c) => {
  const user = c.get("user");
  const surveyId = c.req.param("id");
  const input = await parseBody(c.req.raw, draftSchema);

  const survey = await getSurvey(surveyId, null, langOf(c));
  if (!survey) notFound("Методика не найдена");
  if (survey.status !== "published") badRequest("Методика недоступна");
  if (survey.anonymous) badRequest("Анонимная методика не сохраняет черновики");

  const existing = await db.query.responses.findFirst({
    where: and(
      eq(responses.surveyId, surveyId),
      eq(responses.userId, user.id),
      eq(responses.status, "in_progress"),
    ),
  });

  const responseId = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const validIds = new Set(survey.questions.map((q) => q.id));

  await db.transaction(async (tx) => {
    if (existing) {
      await tx.update(responses)
        .set({ durationMs: input.durationMs, lastSavedAt: now })
        .where(eq(responses.id, responseId));
      await tx.delete(answers).where(eq(answers.responseId, responseId));
    } else {
      await tx.insert(responses)
        .values({
          id: responseId,
          surveyId,
          userId: user.id,
          versionId: survey.versionId,
          status: "in_progress",
          startedAt: input.startedAt,
          lastSavedAt: now,
          durationMs: input.durationMs,
        });
    }

    for (const answer of input.answers) {
      if (!validIds.has(answer.questionId)) continue;
      await tx.insert(answers)
        .values({
          id: crypto.randomUUID(),
          responseId,
          questionId: answer.questionId,
          optionIds: answer.optionIds ?? null,
          text: answer.text ?? null,
          number: answer.number ?? null,
          date: answer.date ?? null,
          matrix: answer.matrix ?? null,
          ranking: answer.ranking ?? null,
          skipped: answer.skipped ?? false,
          score: null,
          durationMs: answer.durationMs ?? 0,
          changeCount: answer.changeCount ?? 0,
          visitCount: answer.visitCount ?? 1,
        });
    }

    for (const risk of detectRisks(survey, input.answers as Answer[])) {
      await tx.insert(riskAlerts)
        .values({
          id: crypto.randomUUID(),
          responseId,
          surveyId,
          questionId: risk.questionId,
          userId: user.id,
          label: risk.label,
          severity: risk.severity,
          at: now,
        })
        .onConflictDoNothing();
    }
  });

  return c.json({ id: responseId, lastSavedAt: now, answers: input.answers.length });
});

/** Незавершённое прохождение, чтобы продолжить с того же места */
responseRoutes.get("/surveys/:id/draft", async (c) => {
  const user = c.get("user");
  const draft = await db.query.responses.findFirst({
    where: and(
      eq(responses.surveyId, c.req.param("id")),
      eq(responses.userId, user.id),
      eq(responses.status, "in_progress"),
    ),
  });
  if (!draft) return c.json(null);

  const rows = await db.select().from(answers).where(eq(answers.responseId, draft.id));
  return c.json({
    id: draft.id,
    startedAt: draft.startedAt,
    lastSavedAt: draft.lastSavedAt,
    durationMs: draft.durationMs,
    answers: rows.map((a) => ({
      questionId: a.questionId,
      optionIds: a.optionIds ?? undefined,
      text: a.text ?? undefined,
      number: a.number ?? undefined,
      date: a.date ?? undefined,
      matrix: a.matrix ?? undefined,
      ranking: a.ranking ?? undefined,
      durationMs: a.durationMs,
      changeCount: a.changeCount,
      visitCount: a.visitCount,
    })),
  });
});

/** Свои прохождения — с баллами, чтобы видеть динамику */
responseRoutes.get("/me/responses", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select()
    .from(responses)
    .where(eq(responses.userId, user.id))
    .orderBy(desc(responses.submittedAt));
  return c.json(await withScores(rows, user.fullName));
});

/** Все прохождения методики — админам */
responseRoutes.get("/surveys/:id/responses", requireStaff, async (c) => {
  await assertSurveyAccess(c.get("user"), c.req.param("id"));

  // курсорная пагинация по времени сдачи: limit+1, чтобы узнать «есть ещё».
  // offset-вариант на живой таблице съезжает при вставках между страницами
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 200);
  const before = c.req.query("before");

  const rows = await db
    .select({ response: responses, userName: users.lastName })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(
      and(
        eq(responses.surveyId, c.req.param("id")),
        before ? sql`${responses.submittedAt} < ${before}` : undefined,
      ),
    )
    .orderBy(desc(responses.submittedAt))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const enriched = await withScores(
    page.map((r) => r.response),
    null,
    new Map(page.map((r) => [r.response.id, r.userName])),
  );

  // выгрузка списка прохождений — это доступ к данным всех респондентов сразу
  await audit(c, {
    action: "response.list",
    resourceType: "survey",
    resourceId: c.req.param("id"),
    details: {
      count: enriched.length,
      subjects: [...new Set(rows.map((r) => r.response.userId).filter(Boolean))].length,
    },
  });

  return c.json({
    rows: enriched,
    hasMore,
    nextBefore: hasMore ? page[page.length - 1]!.response.submittedAt : null,
  });
});

/**
 * Динамика самого пациента — только по методикам, где психолог явно включил
 * показ результатов. Значения — итоговые (стены/T/доля), с интерпретацией,
 * но без клинических рекомендаций: их даёт специалист на приёме.
 */
responseRoutes.get("/me/dynamics", async (c) => {
  const user = c.get("user");
  const surveyRows = await db
    .select()
    .from(surveys)
    .where(eq(surveys.showResultsToPatient, true));
  if (!surveyRows.length) return c.json({ surveys: [] });

  const own = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, user.id),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyRows.map((s) => s.id)),
      ),
    )
    .orderBy(asc(responses.submittedAt));
  if (!own.length) return c.json({ surveys: [] });

  const scoreRows = await db
    .select({ score: responseScores, scale: scales })
    .from(responseScores)
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(inArray(responseScores.responseId, own.map((r) => r.id)));

  const lang = langOf(c);
  const result = surveyRows
    .map((survey) => {
      const mine = own.filter((r) => r.surveyId === survey.id);
      if (!mine.length) return null;
      const byCode = new Map<string, { code: string; title: string; points: { submittedAt: string; value: number; bandLabel: string | null; severity: string | null }[] }>();
      for (const r of mine) {
        for (const { score, scale } of scoreRows.filter((x) => x.score.responseId === r.id)) {
          if (scale.kind !== "clinical") continue; // шкалы лжи пациенту не показываем
          const entry = byCode.get(scale.code) ?? { code: scale.code, title: t(scale.title as never, lang), points: [] };
          entry.points.push({
            submittedAt: r.submittedAt ?? r.startedAt,
            value: score.value,
            bandLabel: score.bandLabel,
            severity: score.severity,
          });
          byCode.set(scale.code, entry);
        }
      }
      return {
        surveyId: survey.id,
        title: t(survey.title as never, lang),
        scales: [...byCode.values()],
      };
    })
    .filter(Boolean);

  return c.json({ surveys: result });
});

/** Детальный разбор прохождения: ответы, баллы и время по каждому вопросу */
responseRoutes.get("/responses/:id", async (c) => {
  const user = c.get("user");
  const response = await db.query.responses.findFirst({
    where: eq(responses.id, c.req.param("id")),
  });
  if (!response) notFound("Прохождение не найдено");
  if (!isStaff(user) && response.userId !== user.id) {
    forbidden("Доступно только автору прохождения или сотруднику");
  }
  // сотрудник видит карту, только если методика в зоне его ответственности
  if (isStaff(user) && response.userId !== user.id) {
    await assertSurveyAccess(user, response.surveyId);
  }

  // читаем методику той версии, которую респондент реально видел
  const survey = await getSurveyForResponse(response.id);
  if (!survey) notFound("Методика не найдена");

  const [answerRows, scoreRows, eventRows] = await Promise.all([
    db.select().from(answers).where(eq(answers.responseId, response.id)),
    db.select().from(responseScores).where(eq(responseScores.responseId, response.id)),
    db.select().from(answerEvents).where(eq(answerEvents.responseId, response.id)),
  ]);

  const eventsByQuestion = new Map<string, typeof eventRows>();
  for (const e of eventRows.sort((a, b) => a.sequence - b.sequence)) {
    const list = eventsByQuestion.get(e.questionId) ?? [];
    list.push(e);
    eventsByQuestion.set(e.questionId, list);
  }

  const answersByQuestion = new Map(answerRows.map((a) => [a.questionId, a]));
  const scaleTitles = new Map(survey.scales.map((s) => [s.id, s]));

  await audit(c, {
    action: "response.read",
    resourceType: "response",
    resourceId: response.id,
    subjectUserId: response.userId,
    details: { surveyId: survey.id, ownRecord: response.userId === user.id },
  });

  return c.json({
    id: response.id,
    survey: { id: survey.id, title: survey.title, scoringEnabled: survey.scoringEnabled },
    status: response.status,
    startedAt: response.startedAt,
    submittedAt: response.submittedAt,
    durationMs: response.durationMs,
    scores: scoreRows.map((s) => ({
      scaleId: s.scaleId,
      scaleCode: scaleTitles.get(s.scaleId)?.code ?? "",
      scaleTitle: scaleTitles.get(s.scaleId)?.title ?? "",
      kind: "clinical" as const,
      correctedScore: s.rawScore,
      value: s.value,
      normalization: s.normalization,
      rawScore: s.rawScore,
      maxScore: s.maxScore,
      percent: s.percent,
      band: s.bandLabel
        ? { label: s.bandLabel, severity: s.severity!, description: null, grade: null, recommendation: null }
        : null,
    })),
    answers: survey.questions
      .filter((q) => q.type !== "info")
      .map((q) => {
        const a = answersByQuestion.get(q.id);
        return {
          questionId: q.id,
          title: q.title,
          type: q.type,
          position: q.position,
          answered: !!a && !a.skipped,
          optionIds: a?.optionIds ?? null,
          text: a?.text ?? null,
          number: a?.number ?? null,
          date: a?.date ?? null,
          matrix: a?.matrix ?? null,
          ranking: a?.ranking ?? null,
          score: a?.score ?? null,
          durationMs: a?.durationMs ?? 0,
          changeCount: a?.changeCount ?? 0,
          visitCount: a?.visitCount ?? 0,
          events: (eventsByQuestion.get(q.id) ?? []).map((e) => ({
            kind: e.kind,
            elapsedMs: e.elapsedMs,
            at: e.at,
            value: e.value,
          })),
        };
      }),
  });
});

async function withScores(
  rows: (typeof responses.$inferSelect)[],
  fallbackName: string | null,
  namesById?: Map<string, string | null>,
): Promise<SurveyResponse[]> {
  if (!rows.length) return [];
  const scoreRows = await db
    .select()
    .from(responseScores)
    .where(inArray(responseScores.responseId, rows.map((r) => r.id)));

  const scaleRows = scoreRows.length
    ? await db.select().from(scales).where(inArray(scales.id, scoreRows.map((s) => s.scaleId)))
    : [];
  const scaleById = new Map(scaleRows.map((s) => [s.id, s]));

  const byResponse = new Map<string, ScoreResult[]>();
  for (const s of scoreRows) {
    const list = byResponse.get(s.responseId) ?? [];
    list.push({
      scaleId: s.scaleId,
      scaleCode: scaleById.get(s.scaleId)?.code ?? "",
      scaleTitle: t(scaleById.get(s.scaleId)?.title as never),
      kind: "clinical",
      correctedScore: s.rawScore,
      value: s.value,
      normalization: s.normalization,
      rawScore: s.rawScore,
      maxScore: s.maxScore,
      percent: s.percent,
      band: s.bandLabel
        ? { label: s.bandLabel, severity: s.severity!, description: null, grade: null, recommendation: null }
        : null,
    });
    byResponse.set(s.responseId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    surveyId: r.surveyId,
    userId: r.userId,
    userName: namesById?.get(r.id) ?? fallbackName,
    status: r.status,
    startedAt: r.startedAt,
    submittedAt: r.submittedAt,
    durationMs: r.durationMs,
    scores: byResponse.get(r.id) ?? [],
  }));
}


