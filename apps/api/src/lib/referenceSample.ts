import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { SurveyFull } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { responseScores, responses, scales } from "../db/schema";
import { rawSignature, valueSignature } from "./comparable";
import { percentileOf } from "./norms";
import { patientRespondent } from "./population";
import { getSurvey } from "./surveys";

/**
 * Референтная выборка для перцентиля — в печатном листе (волна 15, внешний
 * разбор, п. 19) и в динамике человека (там же, доработка координатора).
 *
 * Перцентиль на листе читается как «этот человек выше стольких-то процентов
 * обследованных здесь», и ради этого одного числа выборка обязана описывать
 * людей, обследованных той же мерой. Прежде она была «все сырые баллы
 * методики с тем же кодом шкалы», и ломалась с четырёх сторон сразу:
 *
 *  1. Версии. Код шкалы переживает правку ключа, а сырой балл — нет: у
 *     ревьюера старая версия 0–100 и новая 0–10 шли одним рядом, и
 *     девяносто старых «100» сдвигали перцентиль нового «5» с 50-го на 5-й.
 *     Теперь в выборку идёт та же версия или версия, где сырой балл шкалы
 *     доказанно считается так же: тот же отпечаток ключа (lib/comparable.ts,
 *     rawSignature — то же правило, что у кандидатных норм) И тот же размах
 *     (max_score строки балла). Размах проверяется отдельно, хотя из ключа
 *     он и следует: строку балла пишет сдача, и если ключ когда-нибудь
 *     посчитают иначе, чем записали, — сравнивать с разным потолком всё
 *     равно нельзя.
 *  2. Достоверность. Протокол, проваленный шкалой лжи, — ровно то, что
 *     выборка описывать не должна: у ревьюера замена примеси на
 *     недостоверные протоколы той же версии перцентиль не меняла вовсе.
 *  3. Единица наблюдения. Человек, пересдавший сорок раз, был сорока
 *     наблюдениями — и перевешивал десяток других. Теперь человек — одно
 *     наблюдение: его ПОСЛЕДНЕЕ достоверное прохождение совместимой версии.
 *     Последнее, а не первое (как у кандидатных норм, lib/normCandidates.ts):
 *     норма описывает человека при первой встрече с методикой, а перцентиль
 *     листа отвечает «где он среди тех, кого здесь обследуют», и у каждого из
 *     них в ответ идёт нынешнее состояние, а не давнишнее. Порог
 *     MIN_NORM_SAMPLE (lib/norms.ts) считается поэтому в людях.
 *  4. Кто. Анонимные прохождения не идут — без человека не посчитать людей;
 *     сотрудник, заполнивший методику на себя, — не обследуемый
 *     (patientRespondent, lib/population.ts).
 *
 * Политика — чистой функцией ниже; база только поставляет наблюдения.
 */

/** Одно прохождение одной шкалы — как оно лежит в базе */
export interface Observation {
  responseId: string;
  userId: string | null;
  versionId: string | null;
  reliable: boolean;
  submittedAt: string | null;
  /**
   * Сравниваемая величина: сырой балл у листа (перцентиль стоит рядом с
   * ним), приведённое значение у динамики (её точка — T, стен или доля)
   */
  value: number;
  /** Размах сырого балла той версии */
  maxScore: number;
  /**
   * Единицы величины: "raw" у сырого балла, нормировка строки балла у
   * приведённого (tscore, sten, ratio, raw)
   */
  unit: string;
}

/**
 * С чем сравнивают: версии, где величина считается так же, её размах и
 * единицы.
 *
 * Единицы проверяются у каждой строки, а не только через версию, по той же
 * причине, что и размах: строку балла пишет сдача, и сравнивать T-балл с
 * долей нельзя, даже если версия по отпечатку совместима.
 */
export interface ReferenceTarget {
  versions: ReadonlySet<string>;
  maxScore: number;
  unit: string;
}

/** Позже ли a, чем b: по времени сдачи, при равенстве — по id, а не порядком строк */
function later(a: Observation, b: Observation): boolean {
  const ta = a.submittedAt ? Date.parse(a.submittedAt) : Number.NEGATIVE_INFINITY;
  const tb = b.submittedAt ? Date.parse(b.submittedAt) : Number.NEGATIVE_INFINITY;
  if (ta !== tb) return ta > tb;
  return a.responseId > b.responseId;
}

/**
 * Выборка: по одному значению на человека.
 *
 * Сначала отбрасывается то, что в выборку не идёт вовсе (анонимное,
 * недостоверное, несовместимая версия, размах или единицы), и только потом у
 * человека берётся последнее из оставшегося. Порядок важен: у человека,
 * чей последний протокол провален шкалой лжи, в выборке остаётся его
 * прежний честный, а не пропадает он целиком — и не входит проваленный.
 */
export function referenceSample(observations: readonly Observation[], target: ReferenceTarget): number[] {
  const lastOf = new Map<string, Observation>();
  for (const o of observations) {
    if (!o.userId || !o.reliable || !o.versionId) continue;
    if (!target.versions.has(o.versionId) || o.maxScore !== target.maxScore || o.unit !== target.unit) continue;
    const seen = lastOf.get(o.userId);
    if (!seen || later(o, seen)) lastOf.set(o.userId, o);
  }
  return [...lastOf.values()].map((o) => o.value);
}

/** Перцентиль по выборке людей; меньше MIN_NORM_SAMPLE человек — null */
export function referencePercentile(value: number, sample: readonly number[]): number | null {
  return percentileOf(value, [...sample]);
}

/** Что сравнивается: сырой балл (печатный лист) или приведённое значение — T, стен, доля (динамика) */
export type Measure = "raw" | "value";

/** Точка, для которой нужна выборка: версия, шкала, размах сырого балла и единицы */
export interface SampleTarget {
  versionId: string;
  code: string;
  maxScore: number;
  /** "raw" для меры "raw"; для "value" — нормировка балла точки */
  unit: string;
}

/**
 * Выборки одной методики для набора точек — ответ: «выборка для точки».
 *
 * Одно чтение баллов на методику и одно чтение каждой встреченной версии,
 * сколько бы точек ни спросили: динамика человека спрашивает по точке на
 * каждое его прохождение и каждую шкалу.
 *
 * Мера решает, ЧТО сравнивается и какие версии для этого совместимы:
 *  - "raw" — сырой балл; совместимы версии с тем же отпечатком сырого балла
 *    (rawSignature). Так сравнивает печатный лист: перцентиль стоит рядом с
 *    сырым баллом.
 *  - "value" — приведённое значение; совместимы версии, где одинаковы и
 *    сырой балл, и его перевод (valueSignature: нормировка, нормы, стены), и
 *    в выборку идут только строки, где перевод состоялся (normalized):
 *    сырой балл, оставшийся сырым за отсутствием нормы, среди T-баллов — то
 *    же сравнение в двух единицах. Так сравнивает динамика: её точка — T,
 *    стен или доля.
 * Остальное — достоверность, человек как единица, анонимные и сотрудники,
 * размах и порог в людях — одно для обеих мер (referenceSample выше).
 *
 * Системной ролью: выборка — баллы всех обследованных, без людей и дат, и
 * наружу из неё уходит одно число на точку. Под ролью приложения пациент
 * видит только свои прохождения, и перцентиль в его листе пропадал (волна
 * 13); у сотрудника под «разбитым стеклом» выборка была бы ограничена чужой
 * для него методикой так же случайно.
 */
export async function referenceSamples(
  surveyId: string,
  measure: Measure,
  targets: readonly SampleTarget[],
): Promise<(target: SampleTarget) => number[]> {
  const codes = [...new Set(targets.map((t) => t.code))];
  if (!codes.length) return () => [];

  const rows = await asSystem(() =>
    db
      .select({
        responseId: responses.id,
        userId: responses.userId,
        versionId: responses.versionId,
        reliable: responses.reliable,
        submittedAt: responses.submittedAt,
        value: measure === "raw" ? responseScores.rawScore : responseScores.value,
        maxScore: responseScores.maxScore,
        unit: measure === "raw" ? sql<string>`'raw'` : responseScores.normalization,
        code: scales.code,
      })
      .from(responseScores)
      .innerJoin(responses, eq(responses.id, responseScores.responseId))
      .innerJoin(scales, eq(scales.id, responseScores.scaleId))
      .where(
        and(
          eq(responses.surveyId, surveyId),
          eq(responses.status, "completed"),
          /* то же, что отсечёт политика, — отсекается и здесь: меньше строк тащить */
          eq(responses.reliable, true),
          isNotNull(responses.userId),
          patientRespondent("responses"),
          inArray(scales.code, codes),
          measure === "value" ? eq(responseScores.normalized, true) : undefined,
        ),
      ),
  );

  /*
   * Отпечатки — у каждой версии, встреченной в выборке или в точках; методика
   * версии читается один раз. Версия точки совместима с собой без сравнения,
   * даже если отпечатка у неё нет.
   */
  const signatureOf = measure === "raw" ? rawSignature : valueSignature;
  const signatures = new Map<string, Map<string, string | null>>();
  const versionIds = new Set([
    ...rows.map((r) => r.versionId).filter((v): v is string => !!v),
    ...targets.map((t) => t.versionId),
  ]);
  for (const versionId of versionIds) {
    const full = await asSystem(() => getSurvey(surveyId, versionId, "uk"));
    signatures.set(versionId, new Map(codes.map((code) => [code, full ? signatureOf(full, code) : null])));
  }

  const byCode = new Map<string, Observation[]>();
  for (const r of rows) {
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }

  const memo = new Map<string, number[]>();
  return (target) => {
    const key = `${target.versionId}:${target.code}:${target.maxScore}:${target.unit}`;
    const known = memo.get(key);
    if (known) return known;
    const mine = signatures.get(target.versionId)?.get(target.code) ?? null;
    const versions = new Set([target.versionId]);
    if (mine !== null) {
      for (const [versionId, byVersion] of signatures) if (byVersion.get(target.code) === mine) versions.add(versionId);
    }
    const sample = referenceSample(byCode.get(target.code) ?? [], { versions, maxScore: target.maxScore, unit: target.unit });
    memo.set(key, sample);
    return sample;
  };
}

/**
 * Выборки для всех шкал одного прохождения — ключ: id шкалы его версии.
 *
 * Печатный лист сравнивает сырой балл (мера "raw"). `survey` — методика той
 * версии, которую проходили (getSurveyForResponse): по ней шкала узнаётся по
 * коду. Прохождение без версии (версию удалили) сравнить не с чем —
 * перцентиля у него нет, а не «по всем».
 */
export async function reportReferenceSamples(
  response: { surveyId: string; versionId: string | null },
  survey: SurveyFull,
  scores: readonly { scaleId: string; maxScore: number }[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const own = response.versionId;
  if (!own) return out;
  const codeOf = new Map(survey.scales.map((s) => [s.id, s.code]));
  const targets = scores.flatMap((s) => {
    const code = codeOf.get(s.scaleId);
    return code ? [{ scaleId: s.scaleId, target: { versionId: own, code, maxScore: s.maxScore, unit: "raw" } }] : [];
  });
  const sampleFor = await referenceSamples(response.surveyId, "raw", targets.map((t) => t.target));
  for (const t of targets) out.set(t.scaleId, sampleFor(t.target));
  return out;
}
