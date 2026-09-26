/**
 * Числовая часть графиков — отдельно от компонентов.
 *
 * Лежала в `.tsx` рядом с разметкой и потому не тестировалась: импорт файла
 * тянет react-native, которого в тестовом окружении нет. Здесь нет ни одного
 * импорта — эти функции проверяются как обычная арифметика.
 */

/** Красивые деления оси: 0, 5, 10 вместо 0, 3.7, 7.4 */
export function niceTicks(max: number, count = 4): number[] {
  if (!Number.isFinite(max) || max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  /*
   * Последнее деление всегда не ниже максимума: иначе верхняя точка висит над
   * сеткой, а график, забывший подстраховаться `Math.max(...ticks, max)`,
   * обрежет её совсем. Считаем по индексу, а не накоплением: 0.1 + 0.1 + 0.1
   * даёт 0.30000000000000004, и деления оси разъезжаются на дробных шкалах.
   */
  const last = Math.ceil(max / step);
  return Array.from({ length: last + 1 }, (_, i) => Math.round(i * step * 100) / 100);
}

/** Компактное число для подписи: 1240 → «1,2k» */
export function formatShort(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return `${Math.round(v / 100) / 10}k`;
  return String(Math.round(v * 100) / 100);
}

export interface BoxStat {
  label: string;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  n: number;
}

/**
 * Квартили по массиву значений.
 *
 * Интерполяция между соседними значениями (метод R-7, он же по умолчанию в
 * numpy и Excel): на малых выборках выбор «ближайшего элемента» даёт заметно
 * смещённый межквартильный размах, а групп меньше 20 человек здесь большинство.
 */
export function boxStatsOf(label: string, values: number[]): BoxStat | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
  };
  return {
    label,
    min: s[0]!,
    q1: Math.round(at(0.25) * 100) / 100,
    median: Math.round(at(0.5) * 100) / 100,
    q3: Math.round(at(0.75) * 100) / 100,
    max: s[s.length - 1]!,
    n: values.length,
  };
}

/* ─────────── линия во времени: разрывы и честная ось ─────────── */

/**
 * Счёт по дням — корзиной на каждый день, от первого до последнего.
 *
 * Сервер отдаёт только дни, в которые что-то было, и график ставил их
 * подряд, через равные шаги: три недели тишины между двумя днями выглядели
 * как соседние сутки, а линия шла через пустоту так, будто в ней были
 * замеры. Теперь у каждого дня своё место, а у дня без замера — null: линия
 * на нём рвётся (lineRuns), как в TimeLines веб-набора.
 *
 * Даты — `YYYY-MM-DD`; подпись — `MM-DD`, как было. Дни считаются в UTC:
 * от часового пояса телефона не должно зависеть, сколько дней между двумя
 * датами.
 */
export function dailyBuckets(
  rows: readonly { date: string; count: number }[],
): { x: string; y: number | null }[] {
  const byDay = new Map<string, number>();
  for (const r of rows) {
    const day = r.date.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + r.count);
  }
  const days = [...byDay.keys()].filter((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`))).sort();
  if (!days.length) return [];
  const DAY = 86_400_000;
  const first = Date.parse(`${days[0]}T00:00:00Z`);
  const last = Date.parse(`${days.at(-1)}T00:00:00Z`);
  const out: { x: string; y: number | null }[] = [];
  for (let t = first; t <= last; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push({ x: day.slice(5), y: byDay.get(day) ?? null });
  }
  return out;
}

/**
 * Отрезки подряд идущих известных значений: линия рисуется только внутри
 * отрезка, null её рвёт. Отрезок из одной точки — это точка без линии; её
 * всё равно видно, потому что маркеры рисуются у каждого известного значения.
 */
export function lineRuns(values: readonly (number | null)[]): number[][] {
  const runs: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length) runs.push(run);
      run = [];
    } else run.push(i);
  });
  if (run.length) runs.push(run);
  return runs;
}

/**
 * Положение точек по горизонтали — доля ширины от 0 до 1.
 *
 * Если у всех точек всех рядов известен момент замера (t, мс), ось — время:
 * замеры через день и через месяц стоят на своих расстояниях, как у BandTrend
 * в веб-наборе. Иначе — равные шаги по номеру точки, общие для рядов, как
 * было. Один момент или одна точка — посередине.
 */
export function xFractions(series: readonly { points: readonly { t?: number }[] }[]): number[][] {
  const all = series.flatMap((s) => s.points);
  const timed = all.length > 0 && all.every((p) => typeof p.t === "number" && Number.isFinite(p.t));
  if (timed) {
    const ts = all.map((p) => p.t!);
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    return series.map((s) => s.points.map((p) => (t1 > t0 ? (p.t! - t0) / (t1 - t0) : 0.5)));
  }
  const count = Math.max(0, ...series.map((s) => s.points.length));
  return series.map((s) => s.points.map((_, i) => (count > 1 ? i / (count - 1) : 0.5)));
}
