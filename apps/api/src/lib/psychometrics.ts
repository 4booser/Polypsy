import type { ItemStat, QualityFlags, Question, Reliability } from "@quizzy/shared";
import { cronbachAlpha, pearson, round, variance } from "./stats";

/** Порог, ниже которого ответ считается слишком быстрым для осмысленного чтения пункта */
export const TOO_FAST_MS = 1500;

/**
 * Надёжность субшкалы и вклад каждого пункта.
 *
 * scores[responseId][questionId] — балл пункта на момент прохождения.
 * Считаем только по прохождениям, где отвечены все пункты шкалы: частичные
 * профили смещают и альфу, и корреляции.
 */
export function reliabilityOf(
  items: Question[],
  scores: Map<string, Map<string, number>>,
): Reliability | null {
  if (items.length < 2) return null;

  const complete: number[][] = [];
  for (const byQuestion of scores.values()) {
    const row = items.map((q) => byQuestion.get(q.id));
    if (row.some((v) => v === undefined)) continue;
    complete.push(row as number[]);
  }
  if (complete.length < 3) return null;

  const alpha = cronbachAlpha(complete);
  if (alpha === null) return null;

  const itemStats: ItemStat[] = items.map((question, index) => {
    const own = complete.map((row) => row[index]!);
    // исправленная корреляция: пункт против суммы ОСТАЛЬНЫХ пунктов,
    // иначе пункт коррелирует сам с собой и величина завышена
    const rest = complete.map((row) => row.reduce((sum, v, i) => (i === index ? sum : sum + v), 0));

    const withoutItem = complete.map((row) => row.filter((_, i) => i !== index));
    const alphaIfDeleted = items.length > 2 ? cronbachAlpha(withoutItem) : null;

    return {
      questionId: question.id,
      title: question.title,
      itemTotalCorrelation: round(pearson(own, rest), 3),
      alphaIfDeleted: alphaIfDeleted === null ? null : round(alphaIfDeleted, 3),
      variance: round(variance(own), 3),
    };
  });

  return { alpha: round(alpha, 3), itemCount: items.length, items: itemStats };
}

interface AnswerLike {
  questionId: string;
  durationMs: number;
  optionIds?: string[] | null;
  number?: number | null;
  matrix?: Record<string, string> | null;
  skipped?: boolean;
}

/**
 * Признаки небрежного заполнения.
 *
 * Два независимых маркера: слишком быстрые ответы и «прямая линия» — серия
 * одинаковых выборов подряд. Ни один сам по себе не доказывает недобросовестность,
 * поэтому результат называется флагом и требует взгляда специалиста, а не
 * автоматического исключения из выборки.
 */
export function qualityOf(
  responseId: string,
  respondent: string | null,
  submittedAt: string | null,
  durationMs: number,
  answers: AnswerLike[],
  questions: Question[],
  tooFastMs: number = TOO_FAST_MS,
  /** Ошибки Гуттмана по ключевой шкале, если её удалось построить */
  personFit: number | null = null,
): QualityFlags {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answered = answers.filter((a) => !a.skipped);

  const timed = answered.filter((a) => a.durationMs > 0);
  const tooFast = timed.filter((a) => a.durationMs < tooFastMs).length;
  const tooFastShare = timed.length ? round((tooFast / timed.length) * 100, 1) : 0;

  let longestStraightLine = 0;

  // внутри матричного вопроса: одинаковый столбец во всех строках
  for (const a of answered) {
    const q = byId.get(a.questionId);
    if (q?.type !== "matrix" || !a.matrix) continue;
    const picks = Object.values(a.matrix);
    if (picks.length > 1 && new Set(picks).size === 1) {
      longestStraightLine = Math.max(longestStraightLine, picks.length);
    }
  }

  // между вопросами: подряд идущие одинаковые числовые ответы
  let run = 1;
  const numeric = answered
    .map((a) => ({ q: byId.get(a.questionId), value: a.number }))
    .filter((x) => x.q && ["scale", "slider", "number"].includes(x.q.type));
  for (let i = 1; i < numeric.length; i++) {
    if (numeric[i]!.value !== null && numeric[i]!.value === numeric[i - 1]!.value) {
      run++;
      longestStraightLine = Math.max(longestStraightLine, run);
    } else {
      run = 1;
    }
  }

  const reasons: string[] = [];
  if (tooFastShare >= 50) reasons.push(`${tooFastShare}% ответов быстрее ${tooFastMs} мс`);
  if (longestStraightLine >= 5) reasons.push(`серия из ${longestStraightLine} одинаковых ответов`);
  if (answered.length >= 5 && durationMs > 0 && durationMs < answered.length * tooFastMs) {
    reasons.push("общее время меньше минимально правдоподобного");
  }
  /*
   * Person-fit: профиль, где трудные пункты сработали, а лёгкие нет, — не
   * «плохой человек», а нетипичный паттерн: небрежность, симуляция или
   * непонятая инструкция. Формулировка нейтральна намеренно.
   */
  if (personFit !== null && personFit >= 0.4) {
    reasons.push(`нетипичный паттерн ответов (${personFit})`);
  }

  return {
    responseId,
    respondent,
    submittedAt,
    durationMs,
    tooFastShare,
    longestStraightLine,
    personFit,
    flagged: reasons.length > 0,
    reasons,
  };
}
