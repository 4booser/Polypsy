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

/** Стандартное отклонение выборки (корень из несмещённой дисперсии) */
export function stdev(values: number[]): number {
  return Math.sqrt(variance(values));
}

/**
 * Асимметрия распределения, несмещённая оценка G1 (Fisher–Pearson).
 *
 *   G1 = √(n(n−1))/(n−2) · m₃ / m₂^1.5,  где mₖ — центральные моменты
 *
 * Источник: Joanes & Gill (1998), The Statistician 47(1), 183–189 — это
 * формула, которую считают SPSS и SAS, и брать «простую» g1 нельзя: на
 * выборках поликлинического размера она занижает асимметрию на десятки
 * процентов, и хвост, из-за которого норму нельзя считать по среднему,
 * выглядит безобидно.
 *
 * Врёт при n < 50: стандартная ошибка G1 равна примерно √(6/n) — на тридцати
 * наблюдениях это 0.45, то есть «сильная асимметрия» и «симметрично»
 * неразличимы. Порог применяет вызывающий код (MIN_N_SHAPE), здесь null
 * отдаётся только там, где величина не определена вовсе.
 */
export function skewness(values: number[]): number | null {
  const n = values.length;
  if (n < 3) return null;
  const mean = average(values);
  let m2 = 0;
  let m3 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 === 0) return null; // нулевой разброс: асимметрии нет, а не «ноль»
  const g1 = m3 / m2 ** 1.5;
  return (Math.sqrt(n * (n - 1)) / (n - 2)) * g1;
}

/**
 * Эксцесс сверх нормального, несмещённая оценка G2 (Joanes & Gill, 1998).
 *
 *   G2 = (n−1)/((n−2)(n−3)) · ((n+1)·g2 + 6),  g2 = m₄/m₂² − 3
 *
 * Ноль означает «хвосты как у нормального»: именно на это допущение опирается
 * перевод сырого балла в T-балл, и большой положительный эксцесс — причина
 * не верить T-баллам на краях шкалы.
 *
 * Врёт при n < 50 сильнее, чем асимметрия: SE(G2) ≈ √(24/n), на пятидесяти
 * это 0.69. Порог — у вызывающего кода; null здесь только при n < 4 или
 * нулевом разбросе.
 */
export function kurtosisExcess(values: number[]): number | null {
  const n = values.length;
  if (n < 4) return null;
  const mean = average(values);
  let m2 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  if (m2 === 0) return null;
  const g2 = m4 / (m2 * m2) - 3;
  return ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6);
}

/**
 * Понедельник недели замера в поясе учреждения, YYYY-MM-DD.
 *
 * День берётся тем же dayOf, что и у timelineByDay, а не делением
 * миллисекунд: иначе замер в воскресенье в 23:30 по Киеву уезжал бы в
 * следующую неделю по Гринвичу, и среднее недели на графике расходилось бы
 * со столбцом того же дня рядом. Неделя — с понедельника, как date_trunc в
 * ряду выраженности (routes/analytics.ts): два ряда на соседних экранах
 * режут время одинаково.
 */
export function weekOf(iso: string | null | undefined): string | null {
  const day = dayOf(iso);
  if (!day) return null;
  const at = new Date(`${day}T00:00:00Z`);
  const back = (at.getUTCDay() + 6) % 7; // понедельник → 0, воскресенье → 6
  at.setUTCDate(at.getUTCDate() - back);
  return at.toISOString().slice(0, 10);
}

/**
 * Среднее по неделям с порогом малых ячеек.
 *
 * Неделя с числом замеров ниже `floor` отдаёт mean: null — «замало даних»,
 * а не ноль и не пропуск: пропущенную неделю линия перешагнула бы, соединив
 * соседей так, будто между ними что-то измерено, а ноль на лестнице тяжести
 * читался бы как «всем стало хорошо». Сам n отдаётся всегда — это объём.
 */
export function weeklyMeans(
  points: { at: string | null; value: number }[],
  floor: number,
): { week: string; n: number; mean: number | null }[] {
  const byWeek = new Map<string, number[]>();
  for (const p of points) {
    const week = weekOf(p.at);
    if (!week || !Number.isFinite(p.value)) continue;
    const list = byWeek.get(week) ?? [];
    list.push(p.value);
    byWeek.set(week, list);
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, values]) => ({
      week,
      n: values.length,
      mean: values.length >= floor ? round(average(values)) : null,
    }));
}

/*
 * Шаги корзин длительности: круглые числа, в которых человек думает о
 * времени. «2–4 хв», а не «1,7–3,4 хв»: корзину читают, а не вычисляют.
 */
const DURATION_STEPS_MS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((s) => s * 1000);

/**
 * Корзины общей длительности прохождения.
 *
 * Ширина — круглый шаг, при котором до 95-го перцентиля выходит не больше
 * десяти корзин; всё, что дольше, — в последнюю, открытую справа (toMs
 * null). Край по 95-му перцентилю, а не по максимуму: один забытый на ночь
 * открытым протокол растянул бы ось на восемь часов, и все остальные легли
 * бы в первую корзину.
 *
 * `hide` — порог малых ячеек (lib/privacy suppress): в маленьком отделении
 * «одна людина проходила дві години» — сведение о человеке.
 */
export function durationBins(
  durations: number[],
  hide: (n: number) => number | null,
): { fromMs: number; toMs: number | null; count: number | null }[] {
  const values = durations.filter((d) => Number.isFinite(d) && d > 0);
  if (!values.length) return [];
  const top = Math.max(quantile(values, 0.95), 1);
  const step = DURATION_STEPS_MS.find((s) => top / s <= 10) ?? DURATION_STEPS_MS.at(-1)!;
  /* floor + 1, а не ceil: сам 95-й перцентиль обязан лечь в закрытую корзину, а не открыть «і довше» */
  const closed = Math.floor(top / step) + 1;
  const counts = new Array<number>(closed + 1).fill(0);
  for (const d of values) {
    const at = Math.min(closed, Math.floor(d / step));
    counts[at] = (counts[at] ?? 0) + 1;
  }
  const bins = counts.map((n, i) => ({
    fromMs: i * step,
    toMs: i === closed ? null : (i + 1) * step,
    count: hide(n),
  }));
  /* открытая корзина без единого замера не нужна: «і довше — 0» ничего не сообщает */
  return counts[closed] === 0 ? bins.slice(0, closed) : bins;
}
