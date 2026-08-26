import { average, median, round } from "./stats";
import type { NormComparison } from "@quizzy/shared";

/**
 * Перцентиль балла относительно накопленной выборки по той же субшкале.
 *
 * Считается «доля выборки строго ниже плюс половина равных» — стандартный
 * приём, который не даёт 0-му и 100-му перцентилю схлопываться на краях.
 * Возвращает null, если выборка слишком мала: перцентиль по трём наблюдениям
 * создаёт видимость точности, которой нет.
 */
export const MIN_NORM_SAMPLE = 10;

export function percentileOf(value: number, sample: number[]): number | null {
  if (sample.length < MIN_NORM_SAMPLE) return null;
  const below = sample.filter((v) => v < value).length;
  const equal = sample.filter((v) => v === value).length;
  return round(((below + equal / 2) / sample.length) * 100, 1);
}

export function normFor(scaleId: string, value: number, sample: number[]): NormComparison | null {
  const percentile = percentileOf(value, sample);
  if (percentile === null) return null;
  return {
    scaleId,
    percentile,
    sampleSize: sample.length,
    sampleMean: round(average(sample), 2),
    sampleMedian: round(median(sample), 2),
  };
}
