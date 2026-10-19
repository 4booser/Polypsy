import { inArray, sql } from "drizzle-orm";
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
import { systemInIndexOrder } from "../db/latest";
import { scales } from "../db/schema";
import { log } from "./log";
import { alphaOf } from "./psychometrics";
import { round, variance } from "./stats";
import { surveysAtVersions, versionKey } from "./surveys";

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
 * Сколько последних прохождений версии идёт в нормативную выборку (SD для
 * RCI и моменты для приведения версий, #188).
 *
 * Прежде выборкой были ВСЕ нормированные баллы всех методик зоны
 * сотрудника: ради динамики одного человека читалось 309 тыс. строк, и
 * число росло с каждым прохождением учреждения (40 с у врача на синтетике).
 * Две тысячи — с запасом для SD: её относительная ошибка ≈ 1/√(2n) — 1,6 %,
 * на RCI и SEM это сотые доли; порог MIN_RCI_SAMPLE (30) остаётся порогом.
 * Пока прохождений версии меньше, выборка та же, что прежде, — все.
 */
export const NORM_SAMPLE = 2000;

/** Пары «методика, версия» без повторов — в порядке первого появления */
function distinctPairs<P extends { surveyId: string; versionId: string | null }>(pairs: readonly P[]): P[] {
  const seen = new Set<string>();
  return pairs.filter((p) => {
    const key = `${p.surveyId}:${p.versionId ?? "-"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Последние `limit` завершённых прохождений КАЖДОЙ пары «методика, версия»
 * — подзапросом LATERAL на пару, путём по индексу (survey_id, submitted_at)
 * (db/latest.ts): сортировка ровно по колонкам индекса, иначе путь по нему не
 * поможет. Пары — строкой JSON (`k` — номер пары в списке). Версия NULL —
 * прохождения без версии (её удалили), как прежде isNull.
 *
 * Одним запросом на все пары, а не запросом на пару: у человека с семью
 * методиками прежде это было по семь списков на выборку и на альфу, каждый
 * в своём переключении роли и сортировки.
 */
const latestOfPairs = (pairs: readonly { surveyId: string; versionId: string | null }[], limit: number) => sql`
  jsonb_to_recordset(${JSON.stringify(pairs.map((p, k) => ({ k, survey_id: p.surveyId, version_id: p.versionId })))}::jsonb)
    as p(k int, survey_id text, version_id text)
  cross join lateral (
    select x.id from responses x
    where x.survey_id = p.survey_id
      and x.version_id is not distinct from p.version_id
      and x.status = 'completed'
    order by x.submitted_at desc
    limit ${limit}::int
  ) r`;

/**
 * Нормативная выборка версий, которые видел человек: нормированные баллы
 * последних NORM_SAMPLE прохождений каждой версии, разложенные по методике,
 * коду шкалы и основе. Ненормированные не идут никуда: сырой балл среди
 * T-баллов — сравнение в двух единицах (см. comparableScores).
 *
 * Только версии из ряда человека: changeOverSeries берёт выборки основ его
 * точек и ничьих больше, — прежде читались все методики зоны сотрудника,
 * включая те, которых человек не проходил.
 *
 * Системной ролью, как выборка перцентиля (lib/referenceSample.ts): это
 * число об учреждении — SD шкалы, — и наружу из неё не уходит ничего, кроме
 * него. Под ролью сотрудника строки те же (методика в его зоне — значит, и
 * все её прохождения), а политика на каждой строке баллов стоила секунды.
 */
export async function normativeSamples(
  pairs: readonly { surveyId: string; versionId: string | null }[],
): Promise<Map<string, number[]>> {
  const samples = new Map<string, number[]>();
  const asked = distinctPairs(pairs);
  if (!asked.length) return samples;
  /*
   * Код шкалы — отдельным маленьким запросом по встреченным шкалам, а не
   * соединением в большом: на соединении планировщик перебирал все шкалы на
   * каждую из двадцати тысяч строк баллов (674 тыс. отброшенных сравнений).
   */
  const { rows, codeOf } = await systemInIndexOrder(async () => {
    const rows = (await db.execute(sql`
      select p.k, rs.scale_id as "scaleId", rs.value, rs.normalized, rs.normalization
      from ${latestOfPairs(asked, NORM_SAMPLE)}
      join response_scores rs on rs.response_id = r.id and rs.normalized = true`)) as unknown as {
      k: number;
      scaleId: string;
      value: number;
      normalized: boolean;
      normalization: string;
    }[];
    const scaleIds = [...new Set(rows.map((r) => r.scaleId))];
    const codes = scaleIds.length
      ? await db.select({ id: scales.id, code: scales.code }).from(scales).where(inArray(scales.id, scaleIds))
      : [];
    return { rows, codeOf: new Map(codes.map((s) => [s.id, s.code])) };
  });
  for (const row of rows) {
    const pair = asked[row.k];
    const code = codeOf.get(row.scaleId);
    if (!pair || code === undefined) continue;
    const key = sampleKey(pair.surveyId, code, basisOf(pair.versionId, row));
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
  const asked = distinctPairs(pairs);
  if (!asked.length) return out;
  /*
   * Методики — ролью вызывающего, как прежде getSurvey на каждую пару, но
   * разом (surveysAtVersions). Язык — украинский: альфа от текстов не
   * зависит, а с выборкой перцентиля (lib/referenceSample.ts) он делит кэш
   * содержимого версий — прежде альфа читала то же содержимое по-русски, и
   * холодная карточка собирала каждую версию дважды.
   */
  const fulls = await surveysAtVersions(asked, "uk");
  const known = asked.filter((p) => fulls.get(versionKey(p.surveyId, p.versionId)));
  if (!known.length) return out;
  /*
   * Последние прохождения — путём по индексу (db/latest.ts): под
   * политиками врача планировщик брал все прохождения методики и
   * сортировал, секунда на версию и рост с каждым чужим прохождением.
   * Системной ролью, как и нормативная выборка выше: альфа — число об
   * учреждении, а политика на каждой строке ответов стоила врачу
   * четверть секунды на версию.
   *
   * Все пары — одним запросом, ответы — в нём же. LEFT JOIN: прохождение без
   * единого ответа — тоже прохождение выборки, и порог ALPHA_MIN считается в
   * прохождениях, как прежде. Ответы — только те поля, по которым считается
   * вклад пункта: текст ответа альфе не нужен.
   */
  const rows = (await systemInIndexOrder(() =>
    db.execute(sql`
      select p.k, r.id as "responseId", a.question_id as "questionId", a.option_ids as "optionIds",
             a.number, a.matrix, a.skipped
      from ${latestOfPairs(known, ALPHA_SAMPLE)}
      left join answers a on a.response_id = r.id`),
  )) as unknown as {
    k: number;
    responseId: string;
    questionId: string | null;
    optionIds: string[] | null;
    number: number | null;
    matrix: Record<string, string> | null;
    skipped: boolean | null;
  }[];

  type Stored = (typeof rows)[number];
  const samples = known.map(() => ({ responses: new Set<string>(), byResponse: new Map<string, Map<string, Stored>>() }));
  for (const a of rows) {
    const sample = samples[a.k];
    if (!sample) continue;
    sample.responses.add(a.responseId);
    if (a.questionId === null) continue;
    const m = sample.byResponse.get(a.responseId) ?? new Map<string, Stored>();
    m.set(a.questionId, a);
    sample.byResponse.set(a.responseId, m);
  }

  known.forEach(({ surveyId, versionId }, k) => {
    try {
      const survey = fulls.get(versionKey(surveyId, versionId));
      const sample = samples[k];
      if (!survey || !sample || sample.responses.size < ALPHA_MIN) return;
      const questionById = new Map(survey.questions.map((q) => [q.id, q]));
      for (const scale of survey.scales) {
        if (scale.items.length < 2) continue;
        const matrix = new Map<string, Map<string, number>>();
        for (const [responseId, byQuestion] of sample.byResponse) {
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
              skipped: stored.skipped ?? false,
            });
            if (value !== null) row.set(item.questionId, value);
          }
          if (row.size) matrix.set(responseId, row);
        }
        /* только альфа — без разбора пунктов и омеги, которые reliabilityOf считает для «Якості» */
        const alpha = alphaOf(
          scale.items.map((i) => questionById.get(i.questionId)).filter((q): q is NonNullable<typeof q> => !!q),
          matrix,
        );
        if (alpha !== null) out.set(`${surveyId}:${versionId}:${scale.code}`, alpha);
      }
    } catch (error) {
      log.error("rci.alpha_failed", { surveyId, versionId, error: String(error) });
    }
  });
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
