import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { SurveyFull } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { responseScores, responses, scales } from "../db/schema";
import { rawSignature } from "./comparable";
import { percentileOf } from "./norms";
import { patientRespondent } from "./population";
import { getSurvey } from "./surveys";

/**
 * Референтная выборка для перцентиля в печатном листе (волна 15, внешний
 * разбор, п. 19).
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
  /** Сырой балл: перцентиль на листе стоит рядом с ним и считается по нему */
  value: number;
  /** Размах сырого балла той версии */
  maxScore: number;
}

/** С чем сравнивают: версии, где сырой балл считается так же, и его размах */
export interface ReferenceTarget {
  versions: ReadonlySet<string>;
  maxScore: number;
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
 * недостоверное, несовместимая версия или размах), и только потом у
 * человека берётся последнее из оставшегося. Порядок важен: у человека,
 * чей последний протокол провален шкалой лжи, в выборке остаётся его
 * прежний честный, а не пропадает он целиком — и не входит проваленный.
 */
export function referenceSample(observations: readonly Observation[], target: ReferenceTarget): number[] {
  const lastOf = new Map<string, Observation>();
  for (const o of observations) {
    if (!o.userId || !o.reliable || !o.versionId) continue;
    if (!target.versions.has(o.versionId) || o.maxScore !== target.maxScore) continue;
    const seen = lastOf.get(o.userId);
    if (!seen || later(o, seen)) lastOf.set(o.userId, o);
  }
  return [...lastOf.values()].map((o) => o.value);
}

/** Перцентиль по выборке людей; меньше MIN_NORM_SAMPLE человек — null */
export function referencePercentile(value: number, sample: readonly number[]): number | null {
  return percentileOf(value, [...sample]);
}

/**
 * Выборки для всех шкал одного прохождения — ключ: id шкалы его версии.
 *
 * Системной ролью: выборка — сырые баллы всех обследованных, без людей и
 * дат, и наружу из неё уходит одно число на шкалу. Под ролью приложения
 * пациент видит только свои прохождения, и перцентиль в его листе пропадал
 * (волна 13) — это решение остаётся, меняется только то, КТО в выборку идёт.
 *
 * `survey` — методика той версии, которую проходили (getSurveyForResponse):
 * по ней снимается отпечаток каждой шкалы. Прохождение без версии (версию
 * удалили) сравнить не с чем — перцентиля у него нет, а не «по всем».
 */
export async function reportReferenceSamples(
  response: { surveyId: string; versionId: string | null },
  survey: SurveyFull,
  scores: readonly { scaleId: string; maxScore: number }[],
): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  const own = response.versionId;
  if (!own || !scores.length) return out;

  const codeOf = new Map(survey.scales.map((s) => [s.id, s.code]));
  const codes = [...new Set(scores.map((s) => codeOf.get(s.scaleId)).filter((c): c is string => !!c))];
  if (!codes.length) return out;

  const rows = await asSystem(() =>
    db
      .select({
        responseId: responses.id,
        userId: responses.userId,
        versionId: responses.versionId,
        reliable: responses.reliable,
        submittedAt: responses.submittedAt,
        value: responseScores.rawScore,
        maxScore: responseScores.maxScore,
        code: scales.code,
      })
      .from(responseScores)
      .innerJoin(responses, eq(responses.id, responseScores.responseId))
      .innerJoin(scales, eq(scales.id, responseScores.scaleId))
      .where(
        and(
          eq(responses.surveyId, response.surveyId),
          eq(responses.status, "completed"),
          /* то же, что отсечёт политика, — отсекается и здесь: меньше строк тащить */
          eq(responses.reliable, true),
          isNotNull(responses.userId),
          patientRespondent("responses"),
          inArray(scales.code, codes),
        ),
      ),
  );

  /*
   * Совместимые версии — по отпечатку сырого балла каждой шкалы. Методика
   * каждой встреченной версии читается один раз; своя версия совместима с
   * собой без сравнения.
   */
  const signatures = new Map<string, Map<string, string | null>>();
  for (const versionId of new Set(rows.map((r) => r.versionId).filter((v): v is string => !!v && v !== own))) {
    const full = await asSystem(() => getSurvey(response.surveyId, versionId, "uk"));
    signatures.set(versionId, new Map(codes.map((code) => [code, full ? rawSignature(full, code) : null])));
  }
  const compatible = new Map<string, Set<string>>();
  for (const code of codes) {
    const mine = rawSignature(survey, code);
    const set = new Set([own]);
    if (mine !== null) {
      for (const [versionId, byCode] of signatures) if (byCode.get(code) === mine) set.add(versionId);
    }
    compatible.set(code, set);
  }

  const byCode = new Map<string, Observation[]>();
  for (const r of rows) {
    const list = byCode.get(r.code) ?? [];
    list.push(r);
    byCode.set(r.code, list);
  }
  for (const s of scores) {
    const code = codeOf.get(s.scaleId);
    if (!code) continue;
    out.set(
      s.scaleId,
      referenceSample(byCode.get(code) ?? [], { versions: compatible.get(code) ?? new Set([own]), maxScore: s.maxScore }),
    );
  }
  return out;
}
