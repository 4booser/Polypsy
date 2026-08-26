import { itemContribution, t } from "@quizzy/shared";
import { Hono } from "hono";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  OverviewAnalytics,
  QuestionAnalytics,
  ScaleAnalytics,
  Severity,
  SurveyAnalytics,
} from "@quizzy/shared";
import { db } from "../db";
import { answerEvents, answers, responseScores, responses, surveyVersions, surveys, users } from "../db/schema";
import { notFound } from "../lib/http";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { assertSurveyAccess, surveyScopeFilter } from "../lib/scope";
import { average, distribution, median, percent, round, timelineByDay } from "../lib/stats";
import { TOO_FAST_MS, qualityOf, reliabilityOf } from "../lib/psychometrics";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const analyticsRoutes = new Hono<AppEnv>();

analyticsRoutes.use("*", requireAuth, requireStaff);

/** Сводка по всем методикам */
analyticsRoutes.get("/overview", async (c) => {
  // сводка считается только по методикам, доступным этому сотруднику
  const scope = await surveyScopeFilter(c.get("user"));
  const surveyRows = await db.select().from(surveys).where(scope);
  const scopedIds = surveyRows.map((s) => s.id);

  const [responseRows, scoreRows] = scopedIds.length
    ? await Promise.all([
        db.select().from(responses).where(inArray(responses.surveyId, scopedIds)),
        db
          .select()
          .from(responseScores)
          .innerJoin(responses, eq(responses.id, responseScores.responseId))
          .where(inArray(responses.surveyId, scopedIds))
          .then((rows) => rows.map((r) => r.response_scores)),
      ])
    : [[], []];

  const completed = responseRows.filter((r) => r.status === "completed");
  const durations = completed.map((r) => r.durationMs).filter((d) => d > 0);

  const byS = new Map<string, typeof completed>();
  for (const r of completed) {
    const list = byS.get(r.surveyId) ?? [];
    list.push(r);
    byS.set(r.surveyId, list);
  }

  const severityCounts = new Map<Severity, number>();
  for (const s of scoreRows) {
    if (!s.severity) continue;
    severityCounts.set(s.severity, (severityCounts.get(s.severity) ?? 0) + 1);
  }

  const result: OverviewAnalytics = {
    surveyCount: surveyRows.length,
    publishedCount: surveyRows.filter((s) => s.status === "published").length,
    responseCount: completed.length,
    respondentCount: new Set(completed.map((r) => r.userId).filter(Boolean)).size,
    avgDurationMs: Math.round(average(durations)),
    completionRate: percent(completed.length, responseRows.length),
    topSurveys: [...byS.entries()]
      .map(([surveyId, list]) => ({
        surveyId,
        title: t(surveyRows.find((s) => s.id === surveyId)?.title as never) || "—",
        responseCount: list.length,
        avgDurationMs: Math.round(average(list.map((r) => r.durationMs).filter((d) => d > 0))),
      }))
      .sort((a, b) => b.responseCount - a.responseCount)
      .slice(0, 10),
    severityBreakdown: (["none", "mild", "moderate", "severe"] as Severity[])
      .map((severity) => ({ severity, count: severityCounts.get(severity) ?? 0 }))
      .filter((s) => s.count > 0),
    timeline: timelineByDay(completed.map((r) => r.submittedAt)),
  };
  await audit(c, { action: "analytics.overview", details: { responseCount: result.responseCount } });
  return c.json(result);
});

/** Полная аналитика по одной методике */
analyticsRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);

  /*
   * Выбор версии. По умолчанию берём НЕ действующую, а ту, где больше всего
   * прохождений: после правки методики действующая версия пуста, и аналитика
   * по ней показывала бы нули при полной базе ответов на старой версии.
   */
  const versionRows = await db
    .select({
      id: surveyVersions.id,
      version: surveyVersions.version,
      note: surveyVersions.note,
      responseCount: sql<number>`(select count(*) from responses r where r.version_id = "survey_versions"."id" and r.status = 'completed')`,
    })
    .from(surveyVersions)
    .where(eq(surveyVersions.surveyId, surveyId))
    .orderBy(desc(surveyVersions.version));

  const versions = versionRows.map((v) => ({ ...v, responseCount: Number(v.responseCount ?? 0) }));
  const requested = c.req.query("versionId");
  const chosen =
    (requested ? versions.find((v) => v.id === requested) : undefined) ??
    [...versions].sort((a, b) => b.responseCount - a.responseCount || b.version - a.version)[0] ??
    null;
  const survey = await getSurvey(surveyId, chosen?.id ?? null);
  if (!survey) notFound("Методика не найдена");

  // диапазон дат: аналитика «за квартал» и «до/после ротации» — разные вопросы
  const from = c.req.query("from");
  const to = c.req.query("to");

  // считаем только по прохождениям выбранной версии: смешивать ответы разных
  // редакций методики нельзя — вопросы у них разные
  const responseRows = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.surveyId, surveyId),
        chosen ? eq(responses.versionId, chosen.id) : undefined,
        from ? sql`${responses.submittedAt} >= ${from}` : undefined,
        // верхняя граница включительно: пользователь выбирает день, а не момент
        to ? sql`${responses.submittedAt} < (${to}::date + 1)` : undefined,
      ),
    );
  const responseIds = responseRows.map((r) => r.id);

  const [answerRows, scoreRows, eventRows] = responseIds.length
    ? await Promise.all([
        db.select().from(answers).where(inArray(answers.responseId, responseIds)),
        db.select().from(responseScores).where(inArray(responseScores.responseId, responseIds)),
        db.select().from(answerEvents).where(inArray(answerEvents.responseId, responseIds)),
      ])
    : [[], [], []];

  // время до первого выбора берём из ленты событий: это не то же самое, что
  // общее время на вопросе — человек мог долго думать, а потом быстро передумать
  const firstAnswerByKey = new Map<string, number>();
  const changedKeys = new Set<string>();
  for (const e of eventRows) {
    const key = `${e.responseId}:${e.questionId}`;
    if (e.kind === "set" && !firstAnswerByKey.has(key)) firstAnswerByKey.set(key, e.elapsedMs);
    if (e.kind === "change") changedKeys.add(key);
  }

  const completed = responseRows.filter((r) => r.status === "completed");
  const abandoned = responseRows.filter((r) => r.status === "abandoned");
  const durations = completed.map((r) => r.durationMs).filter((d) => d > 0);

  const answersByQuestion = new Map<string, typeof answerRows>();
  for (const a of answerRows) {
    const list = answersByQuestion.get(a.questionId) ?? [];
    list.push(a);
    answersByQuestion.set(a.questionId, list);
  }

  const questionStats: QuestionAnalytics[] = survey.questions
    .filter((q) => q.type !== "info")
    .map((question) => {
      const given = answersByQuestion.get(question.id) ?? [];
      const real = given.filter((a) => !a.skipped);
      const times = real.map((a) => a.durationMs).filter((d) => d > 0);

      const base: QuestionAnalytics = {
        questionId: question.id,
        title: question.title,
        type: question.type,
        position: question.position,
        shown: given.length,
        answered: real.length,
        skipped: given.length - real.length,
        skipRate: percent(given.length - real.length, given.length),
        avgDurationMs: Math.round(average(times)),
        medianDurationMs: Math.round(median(times)),
        minDurationMs: times.length ? Math.min(...times) : 0,
        maxDurationMs: times.length ? Math.max(...times) : 0,
        avgChangeCount: round(average(real.map((a) => a.changeCount)), 2),
        avgTimeToFirstAnswerMs: Math.round(
          average(
            real
              .map((a) => firstAnswerByKey.get(`${a.responseId}:${a.questionId}`))
              .filter((v): v is number => v !== undefined),
          ),
        ),
        changedShare: percent(
          real.filter((a) => changedKeys.has(`${a.responseId}:${a.questionId}`) || a.changeCount > 0)
            .length,
          real.length,
        ),
        tooFastShare: percent(
          times.filter((t) => t < (survey.tooFastMs ?? TOO_FAST_MS)).length,
          times.length,
        ),
      };

      const choiceTypes = ["single", "multiple", "yesno", "matrix", "ranking"];
      if (choiceTypes.includes(question.type)) {
        const counts = new Map<string, number>();
        // сумма позиций варианта по всем ответам — из неё считаем средний ранг
        const rankSums = new Map<string, number>();
        let totalPicks = 0;

        for (const a of real) {
          if (question.type === "matrix") {
            for (const id of Object.values(a.matrix ?? {})) {
              counts.set(id, (counts.get(id) ?? 0) + 1);
              totalPicks++;
            }
          } else if (question.type === "ranking") {
            (a.ranking ?? []).forEach((id, index) => {
              counts.set(id, (counts.get(id) ?? 0) + 1);
              rankSums.set(id, (rankSums.get(id) ?? 0) + index + 1);
              totalPicks++;
            });
          } else {
            for (const id of a.optionIds ?? []) {
              counts.set(id, (counts.get(id) ?? 0) + 1);
              totalPicks++;
            }
          }
        }

        base.options = question.options
          .filter((o) => o.kind === "option")
          .map((o) => {
            const count = counts.get(o.id) ?? 0;
            return {
              optionId: o.id,
              text: o.text,
              count,
              // у матрицы каждый респондент заполняет все строки, поэтому база —
              // общее число ячеек, иначе доли суммарно превышают 100%
              percent: question.type === "matrix" ? percent(count, totalPicks) : percent(count, real.length),
              ...(question.type === "ranking" && count > 0
                ? { avgRank: round((rankSums.get(o.id) ?? 0) / count, 2) }
                : {}),
            };
          });

        // в ранжировании каждый вариант выбирается ровно один раз — сортируем
        // по среднему рангу, доля вариантов там неинформативна
        if (question.type === "ranking") {
          base.options.sort((a, b) => (a.avgRank ?? 0) - (b.avgRank ?? 0));
        }
      }

      if (["scale", "slider", "number"].includes(question.type)) {
        const values = real.map((a) => a.number).filter((v): v is number => v !== null);
        base.numeric = {
          average: round(average(values)),
          median: round(median(values)),
          min: values.length ? Math.min(...values) : 0,
          max: values.length ? Math.max(...values) : 0,
          distribution: distribution(values),
        };
      }

      if (["text", "longtext"].includes(question.type)) {
        base.texts = real.map((a) => a.text).filter((t): t is string => !!t);
      }

      return base;
    });

  // на каком вопросе теряются респонденты
  let previousReached = responseRows.length;
  const dropOff = questionStats.map((q) => {
    const reached = q.shown;
    const lost = Math.max(0, previousReached - reached);
    previousReached = reached;
    return { questionId: q.questionId, title: q.title, position: q.position, reached, lost };
  });

  const scoresByScale = new Map<string, typeof scoreRows>();
  for (const s of scoreRows) {
    const list = scoresByScale.get(s.scaleId) ?? [];
    list.push(s);
    scoresByScale.set(s.scaleId, list);
  }

  /*
   * Балл каждого пункта по каждому прохождению — основа психометрики.
   *
   * Считаем вклад заново по ключу шкалы, а не берём answers.score: у методик
   * с ключом вклад определяется совпадением ответа с ожидаемым «Да»/«Нет»,
   * а не баллом варианта, и один пункт может входить в разные шкалы по-разному.
   */
  const answersByResponseId = new Map<string, Map<string, (typeof answerRows)[number]>>();
  for (const a of answerRows) {
    const map = answersByResponseId.get(a.responseId) ?? new Map();
    map.set(a.questionId, a);
    answersByResponseId.set(a.responseId, map);
  }

  const questionById = new Map(survey.questions.map((q) => [q.id, q]));
  const contributionsFor = (scale: (typeof survey.scales)[number]) => {
    const matrix = new Map<string, Map<string, number>>();
    for (const [responseId, byQuestion] of answersByResponseId) {
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
    return matrix;
  };

  const scaleStats: ScaleAnalytics[] = survey.scales.map((scale) => {
    const own = scoresByScale.get(scale.id) ?? [];
    // распределение считаем по итоговому значению: полосы норм заданы на нём,
    // а не на сыром балле
    const values = own.map((s) => s.value);

    // порядок берём из определения шкалы, а не из порядка появления в данных:
    // нормы должны идти по возрастанию тяжести, и пустые тоже видны
    const counts = new Map<string, number>();
    for (const s of own) {
      if (!s.bandLabel) continue;
      counts.set(s.bandLabel, (counts.get(s.bandLabel) ?? 0) + 1);
    }

    return {
      scaleId: scale.id,
      code: scale.code,
      title: scale.title,
      average: round(average(values)),
      median: round(median(values)),
      min: values.length ? Math.min(...values) : 0,
      max: values.length ? Math.max(...values) : 0,
      maxPossible: own[0]?.maxScore ?? 0,
      bands: scale.bands.map((band) => ({
        label: band.label,
        severity: band.severity,
        count: counts.get(band.label) ?? 0,
        percent: percent(counts.get(band.label) ?? 0, own.length),
      })),
      reliability: reliabilityOf(
        scale.items
          .map((i) => questionById.get(i.questionId))
          .filter((q): q is NonNullable<typeof q> => !!q),
        contributionsFor(scale),
      ),
    };
  });

  const answersByResponse = new Map<string, typeof answerRows>();
  for (const a of answerRows) {
    const list = answersByResponse.get(a.responseId) ?? [];
    list.push(a);
    answersByResponse.set(a.responseId, list);
  }

  const respondentNames = new Map<string, string>();
  const respondentIds = [...new Set(completed.map((r) => r.userId).filter((id): id is string => !!id))];
  if (respondentIds.length) {
    const rows = await db.select().from(users).where(inArray(users.id, respondentIds));
    for (const u of rows) respondentNames.set(u.id, fullNameOf(u));
  }

  // порог берём из настроек методики: у матричной и у «да/нет» он разный
  const tooFastMs = survey.tooFastMs ?? TOO_FAST_MS;
  const quality = completed
    .map((r) =>
      qualityOf(
        r.id,
        r.userId ? (respondentNames.get(r.userId) ?? null) : null,
        r.submittedAt,
        r.durationMs,
        answersByResponse.get(r.id) ?? [],
        survey.questions,
        tooFastMs,
      ),
    )
    .filter((q) => q.flagged)
    .sort((a, b) => b.reasons.length - a.reasons.length);

  const result: SurveyAnalytics = {
    surveyId,
    title: survey.title,
    versionId: chosen?.id ?? null,
    versionNumber: chosen?.version ?? survey.versionNumber,
    versions,
    started: responseRows.length,
    completed: completed.length,
    abandoned: abandoned.length,
    completionRate: percent(completed.length, responseRows.length),
    avgDurationMs: Math.round(average(durations)),
    medianDurationMs: Math.round(median(durations)),
    dropOff,
    questions: questionStats,
    scales: scaleStats,
    timeline: timelineByDay(completed.map((r) => r.submittedAt)),
    quality,
    tooFastThresholdMs: tooFastMs,
  };
  await audit(c, {
    action: "analytics.survey",
    resourceType: "survey",
    resourceId: surveyId,
    details: { completed: result.completed },
  });
  return c.json(result);
});

/** Выгрузка сырых данных прохождений в CSV */
analyticsRoutes.get("/surveys/:id/export", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId);
  if (!survey) notFound("Методика не найдена");

  const responseRows = await db
    .select()
    .from(responses)
    .where(eq(responses.surveyId, surveyId))
    .orderBy(desc(responses.submittedAt));

  const answerRows = responseRows.length
    ? await db.select().from(answers).where(inArray(answers.responseId, responseRows.map((r) => r.id)))
    : [];

  const optionText = new Map(survey.questions.flatMap((q) => q.options.map((o) => [o.id, o.text])));
  const asked = survey.questions.filter((q) => q.type !== "info");

  const header = [
    "response_id",
    "user_id",
    "status",
    "started_at",
    "submitted_at",
    "duration_ms",
    ...asked.flatMap((q) => [`q${q.position + 1}_answer`, `q${q.position + 1}_ms`, `q${q.position + 1}_changes`]),
  ];

  const byResponse = new Map<string, Map<string, (typeof answerRows)[number]>>();
  for (const a of answerRows) {
    const map = byResponse.get(a.responseId) ?? new Map();
    map.set(a.questionId, a);
    byResponse.set(a.responseId, map);
  }

  const rows = responseRows.map((r) => {
    const map = byResponse.get(r.id) ?? new Map();
    return [
      r.id,
      r.userId ?? "",
      r.status,
      r.startedAt,
      r.submittedAt ?? "",
      String(r.durationMs),
      ...asked.flatMap((q) => {
        const a = map.get(q.id);
        return [formatAnswer(a, optionText), String(a?.durationMs ?? ""), String(a?.changeCount ?? "")];
      }),
    ];
  });

  // выгрузка увозит персональные данные за пределы системы — самое чувствительное
  // событие журнала, фиксируем состав выгрузки
  await audit(c, {
    action: "analytics.export",
    resourceType: "survey",
    resourceId: surveyId,
    details: {
      format: "csv",
      rows: responseRows.length,
      subjects: [...new Set(responseRows.map((r) => r.userId).filter(Boolean))].length,
      includesUserIds: true,
    },
  });

  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="survey-${surveyId}.csv"`,
    },
  });
});

function formatAnswer(
  a: { optionIds?: string[] | null; text?: string | null; number?: number | null; date?: string | null; matrix?: Record<string, string> | null; ranking?: string[] | null; skipped?: boolean } | undefined,
  optionText: Map<string, string>,
): string {
  if (!a || a.skipped) return "";
  if (a.optionIds?.length) return a.optionIds.map((id) => optionText.get(id) ?? id).join("; ");
  if (a.matrix) {
    return Object.entries(a.matrix)
      .map(([row, opt]) => `${optionText.get(row) ?? row}=${optionText.get(opt) ?? opt}`)
      .join("; ");
  }
  if (a.ranking?.length) return a.ranking.map((id) => optionText.get(id) ?? id).join(" > ");
  if (a.number !== null && a.number !== undefined) return String(a.number);
  if (a.date) return a.date;
  return a.text ?? "";
}

function csvCell(value: string): string {
  return /[",\n;]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
