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

/**
 * Слияние локальных норм с уже имеющимися.
 *
 * Отдельной функцией, потому что раньше здесь было присваивание, и это
 * стоило женщинам нормирования: публикация разрешена, если набралась хотя
 * бы одна группа, и в учреждении с сорока мужчинами и двенадцатью женщинами
 * публиковалась мужская норма, а женская из пособия исчезала. Все женщины с
 * этого момента попадали в ветку «нормы нет» — сырой балл вместо T-балла,
 * никакой полосы и выключенная шкала лжи.
 *
 * Заменяется только та группа, для которой набралась своя выборка.
 */
export function mergeNorms<T extends { sex: string | null }>(existing: T[], fresh: T[]): T[] {
  const replaced = new Set<string | null>(fresh.map((g) => g.sex));
  return [...existing.filter((n) => !replaced.has(n.sex)), ...fresh];
}
