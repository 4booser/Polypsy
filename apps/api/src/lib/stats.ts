import { dayOf } from "./day";
/** Небольшие статистические помощники для аналитики */

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Квантиль с линейной интерполяцией между соседями.
 *
 * Интерполяция, а не «взять элемент по индексу»: на девяти наблюдениях
 * четверть приходится ровно между вторым и третьим, и округление индекса
 * сдвигает границу коробки на целое наблюдение. На малых выборках, а в
 * поликлинике они малые, это заметный сдвиг.
 */
export function quantile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

export function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percent(part: number, total: number): number {
  return total > 0 ? round((part / total) * 100, 1) : 0;
}

/** Гистограмма числовых значений, отсортированная по значению */
export function distribution(values: number[]): { value: number; count: number }[] {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value - b.value);
}

/**
 * Группировка по дню в формате YYYY-MM-DD, в поясе учреждения.
 *
 * Здесь стояло `ts.slice(0, 10)` — то есть день по Гринвичу. Для Киева всё,
 * сданное после девяти вечера, уезжало во вчерашний день, независимо от
 * того, где развёрнут сервер. Соседний экран считал тот же замер средствами
 * Postgres и получал другой день.
 */
export function timelineByDay(timestamps: (string | null)[]): { date: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const ts of timestamps) {
    const date = dayOf(ts);
    if (!date) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** Дисперсия выборки (несмещённая) */
export function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = average(values);
  return values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
}

/** Корреляция Пирсона */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = average(xs.slice(0, n));
  const my = average(ys.slice(0, n));
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i]! - mx;
    const b = ys[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const denom = Math.sqrt(dx * dy);
  return denom === 0 ? 0 : num / denom;
}

/**
 * Альфа Кронбаха — внутренняя согласованность шкалы.
 *
 * matrix[i] — вектор баллов одного респондента по пунктам шкалы.
 * Возвращает null, если пунктов меньше двух или суммарный балл не варьируется:
 * в этих случаях величина не определена, и подставлять ноль было бы враньём.
 */
export function cronbachAlpha(matrix: number[][]): number | null {
  const rows = matrix.filter((r) => r.length > 0);
  if (rows.length < 2) return null;
  const k = rows[0]!.length;
  if (k < 2) return null;

  const itemVariances: number[] = [];
  for (let item = 0; item < k; item++) {
    itemVariances.push(variance(rows.map((r) => r[item] ?? 0)));
  }
  const totals = rows.map((r) => r.reduce((a, b) => a + b, 0));
  const totalVariance = variance(totals);
  if (totalVariance === 0) return null;

  const sumItemVariance = itemVariances.reduce((a, b) => a + b, 0);
  return (k / (k - 1)) * (1 - sumItemVariance / totalVariance);
}
