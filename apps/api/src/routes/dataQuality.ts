import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { icc21, psi } from "@quizzy/shared";
import { db } from "../db";
import { answers, responseScores, responses, scales } from "../db/schema";
import { audit } from "../lib/audit";
import { langOf, notFound, parseQuery } from "../lib/http";
import { percent, round } from "../lib/stats";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const dataQualityRoutes = new Hono<AppEnv>();

dataQualityRoutes.use("*", requireAuth, requireStaff);

/** Страта меньше — наружу не показываем (П-1: подавление малых ячеек) */
const SMALL_CELL_FLOOR = 5;
/** Пары для тест-ретеста: интервал в днях */
const RETEST_MIN_DAYS = 7;
const RETEST_MAX_DAYS = 60;
const RETEST_MIN_PAIRS = 10;
/** Корзин для PSI по баллу */
const PSI_BINS = 5;

/**
 * Качество данных (этап 7): дрейф выборки, отсев по стратам, тест-ретест.
 *
 * Все три отвечают на вопросы, которые обычная аналитика не задаёт:
 * «те же ли люди приходят», «кто до конца не доходит» и «повторяем ли мы
 * измерение или каждый раз меряем заново».
 */
dataQualityRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("err.surveyNotFound");

  const allResponses = await db
    .select()
    .from(responses)
    .where(eq(responses.surveyId, surveyId));
  const completed = allResponses.filter((r) => r.status === "completed");

  /* ── 7.3: доходимость и пропуски по стратам ── */
  const answered = completed.length
    ? await db
        .select({ responseId: answers.responseId, questionId: answers.questionId, skipped: answers.skipped })
        .from(answers)
        .where(inArray(answers.responseId, completed.map((r) => r.id)))
    : [];
  const askedCount = survey.questions.filter((q) => q.type !== "info").length;
  const answeredCount = new Map<string, number>();
  for (const a of answered) {
    if (a.skipped) continue;
    answeredCount.set(a.responseId, (answeredCount.get(a.responseId) ?? 0) + 1);
  }

  const strataKeys = new Map<string, { started: number; completed: number; skipped: number }>();
  for (const r of allResponses) {
    const key =
      r.respondentSex && r.respondentAgeBand ? `${r.respondentSex}|${r.respondentAgeBand}` : null;
    if (!key) continue;
    const cell = strataKeys.get(key) ?? { started: 0, completed: 0, skipped: 0 };
    cell.started += 1;
    if (r.status === "completed") {
      cell.completed += 1;
      const done = answeredCount.get(r.id) ?? 0;
      cell.skipped += Math.max(0, askedCount - done);
    }
    strataKeys.set(key, cell);
  }

  const strata = [...strataKeys.entries()]
    .map(([key, v]) => {
      const [sex, band] = key.split("|");
      // подавление малых ячеек: страта меньше порога наружу не выходит
      if (v.started < SMALL_CELL_FLOOR) {
        return { sex, band, suppressed: true as const };
      }
      return {
        sex,
        band,
        suppressed: false as const,
        started: v.started,
        completed: v.completed,
        completionRate: percent(v.completed, v.started),
        avgSkipped: v.completed ? round(v.skipped / v.completed, 2) : 0,
      };
    })
    .sort((a, b) => `${a.sex}${a.band}`.localeCompare(`${b.sex}${b.band}`));

  /* ── 7.2: дрейф выборки (PSI) по месяцам ── */
  const scoreRows = completed.length
    ? await db
        .select({ score: responseScores, code: scales.code, kind: scales.kind })
        .from(responseScores)
        .innerJoin(scales, eq(scales.id, responseScores.scaleId))
        .where(inArray(responseScores.responseId, completed.map((r) => r.id)))
    : [];
  const monthOf = new Map(completed.map((r) => [r.id, (r.submittedAt ?? "").slice(0, 7)]));

  const drift = survey.scales
    .filter((s) => s.kind === "clinical")
    .map((scale) => {
      const own = scoreRows.filter((r) => r.code === scale.code);
      if (own.length < 40) return null;

      const values = own.map((r) => r.score.value);
      const min = Math.min(...values);
      const max = Math.max(...values);
      if (max === min) return null;
      const binOf = (v: number) => Math.min(PSI_BINS - 1, Math.floor(((v - min) / (max - min)) * PSI_BINS));

      const months = [...new Set(own.map((r) => monthOf.get(r.score.responseId)).filter(Boolean))].sort();
      if (months.length < 2) return null;

      // базовая линия — всё, кроме последнего месяца
      const last = months[months.length - 1]!;
      const baseCounts = new Array(PSI_BINS).fill(0);
      const lastCounts = new Array(PSI_BINS).fill(0);
      for (const r of own) {
        const b = binOf(r.score.value);
        if (monthOf.get(r.score.responseId) === last) lastCounts[b] += 1;
        else baseCounts[b] += 1;
      }
      const lastN = lastCounts.reduce((s: number, v: number) => s + v, 0);
      if (lastN < 20) return null; // на горстке PSI скачет

      const value = psi(baseCounts, lastCounts);
      return value === null
        ? null
        : {
            code: scale.code,
            title: scale.title,
            month: last,
            psi: value,
            n: lastN,
            verdict: value > 0.2 ? "существенный" : value > 0.1 ? "заметный" : "стабильно",
          };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  /* ── 7.5: тест-ретест ICC(2,1) ── */
  const byUser = new Map<string, typeof completed>();
  for (const r of completed) {
    if (!r.userId || !r.submittedAt) continue;
    const list = byUser.get(r.userId) ?? [];
    list.push(r);
    byUser.set(r.userId, list);
  }
  const valueOf = new Map<string, Map<string, number>>();
  for (const r of scoreRows) {
    const m = valueOf.get(r.code) ?? new Map<string, number>();
    m.set(r.score.responseId, r.score.value);
    valueOf.set(r.code, m);
  }

  const retest = survey.scales
    .filter((s) => s.kind === "clinical")
    .map((scale) => {
      const byCode = valueOf.get(scale.code);
      if (!byCode) return null;
      const pairs: [number, number][] = [];
      for (const list of byUser.values()) {
        const sorted = [...list].sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
        for (let i = 1; i < sorted.length; i++) {
          const gapDays =
            (new Date(sorted[i]!.submittedAt!).getTime() - new Date(sorted[i - 1]!.submittedAt!).getTime()) /
            86_400_000;
          // окно интервала: раньше — память об ответах, позже — реальные
          // изменения состояния, и то и другое не про надёжность инструмента
          if (gapDays < RETEST_MIN_DAYS || gapDays > RETEST_MAX_DAYS) continue;
          const a = byCode.get(sorted[i - 1]!.id);
          const b = byCode.get(sorted[i]!.id);
          if (a === undefined || b === undefined) continue;
          pairs.push([a, b]);
          break; // одна пара на человека: иначе «активные» перевесят выборку
        }
      }
      if (pairs.length < RETEST_MIN_PAIRS) {
        return { code: scale.code, title: scale.title, pairs: pairs.length, icc: null };
      }
      return { code: scale.code, title: scale.title, pairs: pairs.length, icc: icc21(pairs) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  await audit(c, {
    action: "analytics.data_quality",
    resourceType: "survey",
    resourceId: surveyId,
    details: { strata: strata.length, drift: drift.length },
  });

  return c.json({
    surveyId,
    title: survey.title,
    smallCellFloor: SMALL_CELL_FLOOR,
    retestWindow: { minDays: RETEST_MIN_DAYS, maxDays: RETEST_MAX_DAYS, minPairs: RETEST_MIN_PAIRS },
    strata,
    drift,
    retest,
  });
});

/**
 * Тепловая карта пунктов: человек × вопрос.
 *
 * Небрежное заполнение выдаёт себя формой, а не средним. Двести пунктов,
 * отвеченных за четыре минуты, видны в таблице чисел плохо; сплошная полоса
 * одинаковых ответов от сорокового пункта до конца — сразу.
 *
 * Показываются две объективные вещи, а не выдуманный «индекс небрежности»:
 * время ответа относительно медианы ЭТОГО пункта и длина серии одинаковых
 * ответов подряд. Что с этим делать, решает человек — сводить два разных
 * признака в одно число значит спрятать от него именно то, на что он смотрит.
 */
dataQualityRoutes.get("/surveys/:id/items", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId, null, langOf(c));
  if (!survey) notFound("err.surveyNotFound");

  const { limit } = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }));

  const asked = survey.questions.filter((q) => q.type !== "info");
  const position = new Map(asked.map((q, i) => [q.id, i]));

  const done = await db
    .select({ id: responses.id, submittedAt: responses.submittedAt, durationMs: responses.durationMs })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")))
    .orderBy(desc(responses.submittedAt))
    .limit(limit);
  if (!done.length) return c.json({ questions: [], rows: [], medians: [] });

  const cells = await db
    .select({
      responseId: answers.responseId,
      questionId: answers.questionId,
      durationMs: answers.durationMs,
      optionIds: answers.optionIds,
      skipped: answers.skipped,
    })
    .from(answers)
    .where(inArray(answers.responseId, done.map((r) => r.id)));

  /*
   * Медиана по каждому пункту, а не общая: первый вопрос читают дольше
   * последнего, а длинная формулировка дольше короткой. Общая медиана
   * пометила бы «слишком быстрым» весь хвост методики.
   */
  const byQuestion = new Map<string, number[]>();
  for (const cell of cells) {
    if (!cell.durationMs) continue;
    const list = byQuestion.get(cell.questionId) ?? [];
    list.push(cell.durationMs);
    byQuestion.set(cell.questionId, list);
  }
  const medians = asked.map((q) => {
    const list = (byQuestion.get(q.id) ?? []).slice().sort((a, b) => a - b);
    if (!list.length) return 0;
    return list[Math.floor(list.length / 2)]!;
  });

  const byResponse = new Map<string, typeof cells>();
  for (const cell of cells) {
    const list = byResponse.get(cell.responseId) ?? [];
    list.push(cell);
    byResponse.set(cell.responseId, list);
  }

  const rows = done.map((r) => {
    const own = byResponse.get(r.id) ?? [];
    const byPos = new Array<(typeof cells)[number] | null>(asked.length).fill(null);
    for (const cell of own) {
      const at = position.get(cell.questionId);
      if (at !== undefined) byPos[at] = cell;
    }

    /*
     * Серия одинаковых ответов. Считается по выбранному варианту, а не по
     * баллу: в шкале с обратными пунктами одинаковый балл получается из
     * разных вариантов, и «серия по баллу» показала бы аккуратное заполнение
     * как небрежное.
     */
    const runs = new Array(asked.length).fill(0);
    let start = 0;
    for (let i = 1; i <= byPos.length; i++) {
      const same =
        i < byPos.length &&
        byPos[i]?.optionIds?.[0] !== undefined &&
        byPos[i]?.optionIds?.[0] === byPos[start]?.optionIds?.[0];
      if (!same) {
        const length = i - start;
        for (let k = start; k < i; k++) runs[k] = length;
        start = i;
      }
    }

    return {
      responseId: r.id,
      submittedAt: r.submittedAt,
      durationMs: r.durationMs,
      cells: byPos.map((cell, i) => ({
        // null — на пункт не отвечали (логика показа или пропуск)
        answered: !!cell && !cell.skipped,
        /*
         * Доля от медианы пункта. Число, а не флаг: порог «слишком быстро»
         * зависит от методики, и прятать его в сервере значит навязывать
         * один порог всем.
         */
        rel: cell?.durationMs && medians[i] ? Math.round((cell.durationMs / medians[i]) * 100) / 100 : null,
        run: runs[i] as number,
      })),
    };
  });

  await audit(c, {
    action: "quality.read",
    resourceType: "survey",
    resourceId: surveyId,
    details: { view: "items", rows: rows.length },
  });

  return c.json({
    questions: asked.map((q, i) => ({ number: i + 1, title: q.title })),
    medians,
    rows,
  });
});
