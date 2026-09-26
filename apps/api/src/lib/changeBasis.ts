import { and, desc, eq, inArray } from "drizzle-orm";
import {
  MIN_RCI_SAMPLE,
  comparability,
  equate,
  itemContribution,
  measurementError,
  rciForDisplay,
  reliableChange,
  type Incomparable,
  type ScaleDynamics,
} from "@quizzy/shared";
import { db } from "../db";
import { answers, responseScores, responses, scales } from "../db/schema";
import { log } from "./log";
import { reliabilityOf } from "./psychometrics";
import { round, variance } from "./stats";
import { getSurvey } from "./surveys";

/**
 * Изменение балла между замерами: на чём оно считается и когда его нет.
 *
 * Одно место на два маршрута — динамику человека (routes/dynamics.ts) и
 * сводку случая для консилиума (routes/referrals.ts). Прежде каждый считал
 * по-своему, и оба неправильно, но по-разному: динамика сравнивала
 * неприведённые версии и сырой балл с T-баллом, сводка — вообще любые версии
 * и с надёжностью, взятой константой 0,8. Один и тот же человек выглядел
 * «достоверно улучшившимся» в одной вкладке и «без изменений» в соседней.
 *
 * Три опоры, и каждая — ответ на отдельный дефект клинического разбора:
 *
 * 1. Выборка для SD и перцентиля — в тех же единицах, что точка: той же
 *    версии и той же нормировки (basisOf). Смешанная выборка давала SD
 *    «между единицами», а не между людьми.
 * 2. Альфа — по той же версии, что последний замер, по её вопросам и по
 *    свежим прохождениям. Прежняя бралась по трёмстам САМЫМ СТАРЫМ
 *    прохождениям методики и сверялась с вопросами действующей версии: после
 *    первой же правки методики ответы старой версии не находили своих
 *    вопросов, и RCI становился null навсегда.
 * 3. Концы сравнения проверяются правилом comparability (shared/rci.ts):
 *    одна версия или приведение, одни единицы, оба протокола достоверны.
 *    Иначе — ни изменения, ни RCI, а причина.
 */

/** Основа балла: версия и нормировка; у ненормированного своей выборки нет */
export const basisOf = (versionId: string | null, score: { normalized: boolean; normalization: string }) =>
  `${versionId ?? "-"}:${score.normalized ? score.normalization : "unnormed"}`;

const sampleKey = (surveyId: string, code: string, basis: string) => `${surveyId}:${code}:${basis}`;

/**
 * Нормативная выборка методик: все нормированные баллы, разложенные по
 * методике, коду шкалы и основе. Ненормированные не идут никуда: сырой
 * балл среди T-баллов — сравнение в двух единицах (см. comparableScores).
 */
export async function normativeSamples(surveyIds: string[]): Promise<Map<string, number[]>> {
  const samples = new Map<string, number[]>();
  if (!surveyIds.length) return samples;
  const rows = await db
    .select({
      value: responseScores.value,
      normalized: responseScores.normalized,
      normalization: responseScores.normalization,
      surveyId: responses.surveyId,
      versionId: responses.versionId,
      code: scales.code,
    })
    .from(responseScores)
    .innerJoin(responses, eq(responses.id, responseScores.responseId))
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(and(inArray(responses.surveyId, surveyIds), eq(responses.status, "completed")));
  for (const row of rows) {
    if (!row.normalized) continue;
    const key = sampleKey(row.surveyId, row.code, basisOf(row.versionId, row));
    const list = samples.get(key) ?? [];
    list.push(row.value);
    samples.set(key, list);
  }
  return samples;
}

/** Сколько прохождений версии идёт в альфу: статистически достаточно и не кладёт МЛО-200 */
const ALPHA_SAMPLE = 300;
/** Меньше — альфа по сути не оценивается */
const ALPHA_MIN = 10;

/**
 * Альфа Кронбаха по версиям: ключ `${surveyId}:${versionId}:${code}`.
 *
 * Выборка — последние ALPHA_SAMPLE завершённых прохождений ЭТОЙ версии, и
 * ответы сопоставляются с вопросами ЭТОЙ версии. Прежде бралось триста самых
 * старых прохождений методики и сверялось с действующей версией: после
 * правки методики старые ответы не находили своих вопросов, и альфа — а с
 * ней RCI — пропадала навсегда, сколько бы новых прохождений ни набралось.
 */
export async function alphasOf(pairs: { surveyId: string; versionId: string }[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const seen = new Set<string>();
  for (const { surveyId, versionId } of pairs) {
    const pairKey = `${surveyId}:${versionId}`;
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    try {
      const survey = await getSurvey(surveyId, versionId, "ru");
      if (!survey) continue;
      const sample = await db
        .select({ id: responses.id })
        .from(responses)
        .where(
          and(eq(responses.surveyId, surveyId), eq(responses.versionId, versionId), eq(responses.status, "completed")),
        )
        .orderBy(desc(responses.submittedAt), desc(responses.id))
        .limit(ALPHA_SAMPLE);
      if (sample.length < ALPHA_MIN) continue;
      const answerRows = await db
        .select()
        .from(answers)
        .where(inArray(answers.responseId, sample.map((r) => r.id)));
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
        if (rel) out.set(`${surveyId}:${versionId}:${scale.code}`, rel.alpha);
      }
    } catch (error) {
      log.error("rci.alpha_failed", { surveyId, versionId, error: String(error) });
    }
  }
  return out;
}

/** Замер шкалы в ряду: всё, что нужно, чтобы решить, с чем его можно сравнивать */
export interface SeriesPoint {
  value: number;
  versionId: string | null;
  versionNo: number | null;
  normalized: boolean;
  normalization: string;
  reliable: boolean;
}

export interface SeriesChange {
  delta: number | null;
  direction: "up" | "down" | "flat" | null;
  incomparable: Incomparable | null;
  reliableChange: ScaleDynamics["reliableChange"];
  /** Ошибка одного измерения в единицах последнего замера — для полосы на графике */
  sem: number | null;
  equated: NonNullable<ScaleDynamics["equated"]> | null;
}

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

/**
 * Изменение первый → последний по ряду одной шкалы (ряд упорядочен по времени).
 *
 * Сопоставимость проверяется у ДВУХ сравниваемых точек, а не у ряда. Прежде
 * хватало одного удачного коэффициента приведения, чтобы весь ряд считался
 * сопоставимым: при трёх версиях 2→3 приводилась, 1→3 — нет (мала
 * выборка), и первая точка вычиталась из последней как есть, в чужих
 * единицах.
 */
export function changeOverSeries(
  points: readonly SeriesPoint[],
  ctx: { surveyId: string; code: string; samples: Map<string, number[]>; alphas: Map<string, number> },
): SeriesChange {
  const none: SeriesChange = {
    delta: null,
    direction: null,
    incomparable: null,
    reliableChange: null,
    sem: null,
    equated: null,
  };
  const last = points[points.length - 1];
  if (!last) return none;

  const sampleOf = (basis: string) => ctx.samples.get(sampleKey(ctx.surveyId, ctx.code, basis)) ?? [];
  const target = basisOf(last.versionId, last);
  const targetSample = sampleOf(target);

  /*
   * SD и альфа — последнего замера: разность считается в его единицах. Порог
   * выборки — общий MIN_RCI_SAMPLE (shared/rci.ts): на десяти наблюдениях SD
   * гуляет на четверть, и «достоверность» решалась бы составом недели.
   */
  const sd = targetSample.length >= MIN_RCI_SAMPLE ? Math.sqrt(variance(targetSample)) : null;
  const alpha = last.versionId ? ctx.alphas.get(`${ctx.surveyId}:${last.versionId}:${ctx.code}`) : undefined;
  const error = sd !== null && alpha !== undefined ? measurementError(sd, alpha) : null;

  /* приведение каждой другой основы ряда к основе последнего замера */
  const toTarget = new Map<string, { slope: number; intercept: number }>();
  const equated: NonNullable<ScaleDynamics["equated"]> = [];
  const bases = new Map(points.map((p) => [basisOf(p.versionId, p), p.versionNo] as const));
  if (bases.size > 1 && last.versionNo !== null && targetSample.length) {
    const to = { version: last.versionNo, n: targetSample.length, mean: mean(targetSample), sd: Math.sqrt(variance(targetSample)) };
    for (const [basis, versionNo] of bases) {
      if (basis === target || versionNo === null) continue;
      const values = sampleOf(basis);
      if (!values.length) continue;
      const eq = equate({ version: versionNo, n: values.length, mean: mean(values), sd: Math.sqrt(variance(values)) }, to);
      if (!eq) continue;
      /* неокруглённые коэффициенты — для счёта; округлённые уходят наружу */
      toTarget.set(basis, { slope: eq.slope, intercept: eq.intercept });
      equated.push({
        fromVersion: eq.from.version,
        toVersion: eq.to.version,
        slope: round(eq.slope),
        intercept: round(eq.intercept),
        fromN: eq.from.n,
        toN: eq.to.n,
      });
    }
  }
  const base: SeriesChange = { ...none, sem: error?.sem ?? null, equated: equated.length ? equated : null };
  if (points.length < 2) return base;

  const first = points[0]!;
  const firstBasis = basisOf(first.versionId, first);
  const conversion = firstBasis === target ? null : (toTarget.get(firstBasis) ?? null);
  const mark = (p: SeriesPoint) => ({
    version: p.versionId,
    normalized: p.normalized,
    normalization: p.normalization,
    reliable: p.reliable,
  });
  const incomparable = comparability(mark(first), mark(last), { equated: conversion !== null });
  if (incomparable) return { ...base, incomparable };

  const from = conversion ? conversion.slope * first.value + conversion.intercept : first.value;
  const delta = Math.round((last.value - from) * 100) / 100;

  let rc: SeriesChange["reliableChange"] = null;
  if (sd !== null && alpha !== undefined) {
    const computed = reliableChange(from, last.value, sd, alpha);
    if (computed) {
      rc = {
        // точное число решает значимость; наружу — показ, не перескакивающий через критерий
        rci: rciForDisplay(computed.rci),
        significant: computed.significant,
        direction: computed.direction,
        basis: { sd: round(sd), alpha, sampleN: targetSample.length },
      };
    }
  }

  return {
    ...base,
    delta,
    direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat",
    reliableChange: rc,
  };
}
