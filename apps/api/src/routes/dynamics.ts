import { Hono } from "hono";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { itemContribution, reliableChange, respondentQuery, t } from "@quizzy/shared";
import type { RespondentDynamics, ScaleDynamics } from "@quizzy/shared";
import { db } from "../db";
import { responseScores, responses, scales, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { notFound, parseQuery } from "../lib/http";
import { percentileOf } from "../lib/norms";
import { getSurvey } from "../lib/surveys";
import { reliabilityOf } from "../lib/psychometrics";
import { round, variance } from "../lib/stats";
import { answers as answersTable } from "../db/schema";
import { surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";
import { log } from "../lib/log";

export const dynamicsRoutes = new Hono<AppEnv>();

dynamicsRoutes.use("*", requireAuth, requireStaff);

/**
 * Кто проходил методики повторно — в зоне ответственности сотрудника.
 *
 * Свёртка делается в базе, а не в приложении: раньше сюда выбирались все
 * завершённые прохождения со стыковкой к пользователям — на двадцати тысячах
 * замеров это двадцать тысяч строк в память ради подсчёта, который база
 * делает одной группировкой.
 *
 * Расшифровываются только те, кто попал на страницу: ФИО зашифровано, и
 * расшифровка всей выборки ради сортировки была бы самой дорогой частью
 * запроса.
 */
dynamicsRoutes.get("/respondents", async (c) => {
  const scope = await surveyScopeFilter(c.get("user"));
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json({ items: [], nextCursor: null, total: 0 });

  // ?limit=abc давал NaN, который уезжал в .limit() и ронял запрос пятисоткой
  const { limit, cursor, search } = parseQuery(c, respondentQuery);

  const base = and(
    inArray(responses.surveyId, surveyIds),
    eq(responses.status, "completed"),
    isNotNull(responses.userId),
  );

  /*
   * При поиске выбираем шире и фильтруем после расшифровки: LIKE по
   * шифртексту ничего не найдёт. На реальных объёмах это несколько тысяч
   * расшифровок — дешевле, чем держать открытую копию имени в базе.
   */
  const rows = await db
    .select({
      userId: responses.userId,
      count: sql<number>`count(*)::int`,
      last: sql<string>`max(${responses.submittedAt})`,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      email: users.email,
    })
    .from(responses)
    .innerJoin(users, eq(users.id, responses.userId))
    .where(base)
    .groupBy(
      responses.userId,
      users.firstName,
      users.lastName,
      users.middleName,
      users.anonymous,
      users.pseudonym,
      users.email,
    )
    /*
     * Курсор проверяется на агрегате, а не на строках прохождений.
     *
     * Условие в WHERE отсекало бы отдельные замеры, но у человека есть и
     * более старые — и он выпадал бы на следующей странице снова, уже с
     * меньшим максимумом. Пагинация по группам обязана фильтровать по тому
     * же значению, по которому сортирует.
     */
    .having(cursor ? sql`max(${responses.submittedAt}) < ${cursor}` : sql`true`)
    .orderBy(sql`max(${responses.submittedAt}) desc`)
    .limit(search ? 2000 : limit + 1);

  const named = rows.map((r) => ({
    userId: r.userId!,
    fullName: fullNameOf(r as never),
    email: r.email,
    count: Number(r.count),
    last: r.last,
  }));
  const matched = search
    ? named.filter((r) => `${r.fullName} ${r.email}`.toLowerCase().includes(search))
    : named;

  const items = matched.slice(0, limit);
  const hasMore = matched.length > limit;

  let total: number | undefined;
  if (!cursor && !search) {
    const [row] = await db
      .select({ n: sql<number>`count(distinct ${responses.userId})::int` })
      .from(responses)
      .where(base);
    total = row?.n ?? 0;
  }

  return c.json({
    items,
    // курсор — время последнего замера: сортировка идёт по нему же
    nextCursor: hasMore && items.length ? items[items.length - 1]!.last : null,
    total,
  });
});

/**
 * Динамика одного пациента: как менялись баллы по субшкалам от замера к замеру.
 *
 * Субшкалы разных версий методики сопоставляются по коду, а не по id —
 * иначе правка методики разрывала бы график пополам.
 */
dynamicsRoutes.get("/respondents/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("Пациент не найден");

  const scope = await surveyScopeFilter(staff);
  const scoped = await db.select().from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) {
    return c.json({ userId, fullName: fullNameOf(patient), email: patient.email, surveys: [] });
  }

  const responseRows = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, userId),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyIds),
      ),
    )
    .orderBy(asc(responses.submittedAt));

  if (!responseRows.length) {
    return c.json({ userId, fullName: fullNameOf(patient), email: patient.email, surveys: [] });
  }

  const scoreRows = await db
    .select()
    .from(responseScores)
    .where(inArray(responseScores.responseId, responseRows.map((r) => r.id)));

  const scaleRows = await db
    .select()
    .from(scales)
    .where(inArray(scales.id, [...new Set(scoreRows.map((s) => s.scaleId))]));
  const scaleById = new Map(scaleRows.map((s) => [s.id, s]));

  // нормативная выборка: все баллы по субшкалам с тем же кодом в той же методике
  const sampleByKey = new Map<string, number[]>();
  const allScores = await db
    .select({ score: responseScores, surveyId: responses.surveyId, scaleCode: scales.code })
    .from(responseScores)
    .innerJoin(responses, eq(responses.id, responseScores.responseId))
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(and(inArray(responses.surveyId, surveyIds), eq(responses.status, "completed")));
  for (const row of allScores) {
    const key = `${row.surveyId}:${row.scaleCode}`;
    const list = sampleByKey.get(key) ?? [];
    list.push(row.score.value);
    sampleByKey.set(key, list);
  }

  const scoresByResponse = new Map<string, typeof scoreRows>();
  for (const s of scoreRows) {
    const list = scoresByResponse.get(s.responseId) ?? [];
    list.push(s);
    scoresByResponse.set(s.responseId, list);
  }

  const bySurvey = new Map<string, typeof responseRows>();
  for (const r of responseRows) {
    const list = bySurvey.get(r.surveyId) ?? [];
    list.push(r);
    bySurvey.set(r.surveyId, list);
  }

  /*
   * Альфа для RCI: считается по фактической выборке методики (последние 300
   * завершённых прохождений — статистически достаточно, а МЛО-200 на тысячах
   * прохождений не кладёт запрос). Ключ — код шкалы: коды стабильны между
   * версиями, id — нет.
   */
  const alphaBySurveyCode = new Map<string, number>();
  for (const surveyId of bySurvey.keys()) {
    try {
      const survey = await getSurvey(surveyId, null, "ru");
      if (!survey) continue;
      const sample = await db
        .select({ id: responses.id })
        .from(responses)
        .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")))
        .orderBy(asc(responses.submittedAt))
        .limit(300);
      if (sample.length < 10) continue;
      const answerRows = await db
        .select()
        .from(answersTable)
        .where(inArray(answersTable.responseId, sample.map((r) => r.id)));
      const byResponse = new Map<string, Map<string, (typeof answerRows)[number]>>();
      for (const a of answerRows) {
        const m = byResponse.get(a.responseId) ?? new Map();
        m.set(a.questionId, a);
        byResponse.set(a.responseId, m);
      }
      const questionById = new Map(survey.questions.map((q) => [q.id, q]));
      for (const scale of survey.scales) {
        if (scale.items.length < 2) continue;
        const matrix = new Map<string, Map<string, number>>();
        for (const [responseId, byQuestion] of byResponse) {
          const row = new Map<string, number>();
          for (const item of scale.items) {
            const question = questionById.get(item.questionId);
            const stored = byQuestion.get(item.questionId);
            if (!question || !stored) continue;
            const value = itemContribution(question, item, {
              questionId: item.questionId,
              optionIds: stored.optionIds ?? undefined,
              number: stored.number ?? undefined,
              matrix: stored.matrix ?? undefined,
              skipped: stored.skipped,
            });
            if (value !== null) row.set(item.questionId, value);
          }
          if (row.size) matrix.set(responseId, row);
        }
        const rel = reliabilityOf(
          scale.items.map((i) => questionById.get(i.questionId)).filter((q): q is NonNullable<typeof q> => !!q),
          matrix,
        );
        if (rel) alphaBySurveyCode.set(`${surveyId}:${scale.code}`, rel.alpha);
      }
    } catch (error) {
      log.error("rci.alpha_failed", { surveyId, error: String(error) });
    }
  }

  const result: RespondentDynamics = {
    userId,
    fullName: fullNameOf(patient),
    email: patient.email,
    surveys: [...bySurvey.entries()].map(([surveyId, list]) => {
      const survey = scoped.find((s) => s.id === surveyId)!;

      // группируем по КОДУ шкалы: id меняется от версии к версии
      const byCode = new Map<string, ScaleDynamics>();
      for (const response of list) {
        for (const score of scoresByResponse.get(response.id) ?? []) {
          const scale = scaleById.get(score.scaleId);
          if (!scale) continue;
          const entry = byCode.get(scale.code) ?? {
            scaleId: scale.id,
            code: scale.code,
            title: t(scale.title as never),
            points: [],
            delta: null,
            direction: null,
            reliableChange: null,
          };
          entry.points.push({
            responseId: response.id,
            submittedAt: response.submittedAt ?? response.startedAt,
            rawScore: score.value,
            maxScore: score.maxScore,
            percent: score.percent,
            bandLabel: score.bandLabel,
            severity: score.severity,
            percentile: percentileOf(score.rawScore, sampleByKey.get(`${surveyId}:${scale.code}`) ?? []),
          });
          byCode.set(scale.code, entry);
        }
      }

      for (const [code, entry] of byCode.entries()) {
        entry.points.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
        if (entry.points.length >= 2) {
          const first = entry.points[0]!.rawScore;
          const last = entry.points[entry.points.length - 1]!.rawScore;
          entry.delta = Math.round((last - first) * 100) / 100;
          entry.direction = entry.delta > 0 ? "up" : entry.delta < 0 ? "down" : "flat";

          // RCI: SD из выборки той же шкалы, альфа — фактическая
          const sample = sampleByKey.get(`${surveyId}:${code}`) ?? [];
          const alpha = alphaBySurveyCode.get(`${surveyId}:${code}`);
          if (sample.length >= 10 && alpha !== undefined) {
            const sd = Math.sqrt(variance(sample));
            const rc = reliableChange(first, last, sd, alpha);
            if (rc) {
              entry.reliableChange = {
                rci: rc.rci,
                significant: rc.significant,
                direction: rc.direction,
                basis: { sd: round(sd), alpha, sampleN: sample.length },
              };
            }
          }
        }
      }

      return {
        surveyId,
        title: t(survey.title as never),
        responseCount: list.length,
        firstAt: list[0]?.submittedAt ?? null,
        lastAt: list[list.length - 1]?.submittedAt ?? null,
        scales: [...byCode.values()],
      };
    }),
  };

  await audit(c, {
    action: "response.read",
    resourceType: "respondent",
    resourceId: userId,
    subjectUserId: userId,
    details: { view: "dynamics", surveys: result.surveys.length },
  });

  return c.json(result);
});
