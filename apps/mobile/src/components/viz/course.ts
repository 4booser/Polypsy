/**
 * Раскладка графика курса (CourseChart) — числа без react-native.
 *
 * Отдельно, потому что решения здесь и есть то, что легко сломать:
 * какая полоса текущая, где граница меж похибки, когда «сьогодні» ещё
 * рисуется, какие даты прячутся, чтобы не налезть друг на друга. Всё это
 * проверяется тестом (test/viz.test.ts), а рисует CourseChart.tsx.
 */
import type { Severity } from "@quizzy/shared";

export interface CoursePoint {
  /** Момент замера, мс */
  t: number;
  /** Дата под осью: «08.10» */
  label: string;
  value: number;
  severity?: Severity | null;
  /** Слово полосы методики («помірна») */
  bandLabel?: string | null;
  /** Ступень набора 0…4, если у методики пять полос */
  step?: 0 | 1 | 2 | 3 | 4;
}

export interface CourseBand {
  /** Нижняя граница полосы (включительно) */
  from: number;
  /** Верхняя граница */
  to: number;
  label: string;
}

type BandClass = "b0" | "b1" | "bc";

export interface CourseLayout {
  left: number;
  top: number;
  plotWidth: number;
  plotHeight: number;
  totalHeight: number;
  bands: (CourseBand & { cls: BandClass; y0: number; y1: number; labelY: number })[];
  ticks: { v: number; y: number }[];
  zone: { y0: number; y1: number } | null;
  todayX: number | null;
  futureX: number | null;
  pts: { x: number; y: number; labelY: number; cls: BandClass; isToday: boolean; dateHidden: boolean }[];
  signals: { x: number; label: string }[];
  hits: { x0: number; x1: number }[];
}

const DAY = 86_400_000;
/** Подписи дат ближе этого налезают друг на друга при кегле 11 */
const DATE_GAP = 38;
/** Деления оси ближе этого сливаются в одно число */
const TICK_GAP = 12;

/** Полоса, в которой стоит значение; верхняя граница последней полосы — её же */
export function bandOf<B extends { from: number; to: number }>(bands: B[], v: number): B | undefined {
  return bands.find((b, i) => (v >= b.from && v < b.to) || (i === bands.length - 1 && v === b.to));
}

export function courseLayout({
  points,
  max,
  min = 0,
  bands = [],
  rc,
  today,
  signals = [],
  width,
  plotHeight = 156,
}: {
  points: CoursePoint[];
  max: number;
  min?: number;
  bands?: CourseBand[];
  rc?: number | null;
  today?: number;
  signals?: { t: number; label: string }[];
  width: number;
  plotHeight?: number;
}): CourseLayout {
  const left = 26;
  const right = 4;
  const top = 26;
  const plotWidth = Math.max(80, width - left - right);
  const totalHeight = top + plotHeight + 24;
  const span = Math.max(1e-9, max - min);
  const Y = (v: number) => top + plotHeight * (1 - (Math.max(min, Math.min(max, v)) - min) / span);

  const ts = points.map((p) => p.t);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const range = t1 - t0;
  /*
   * «Сьогодні» рисуется, только если она недалеко за последним замером:
   * полгода тишины после курса сжали бы все замеры в левый угол ради одной
   * вертикальной черты.
   */
  const showToday = today !== undefined && today >= t0 && today - t1 <= Math.max(range * 0.5, 14 * DAY);
  const tEnd = showToday ? Math.max(t1, today!) : t1;
  const pad = Math.max((tEnd - t0) * 0.06, DAY);
  const d0 = t0 - pad;
  const d1 = tEnd + pad;
  const X = (t: number) =>
    points.length === 1 && !showToday ? left + plotWidth / 2 : left + (plotWidth * (t - d0)) / (d1 - d0);

  const last = points[points.length - 1]!;
  const current = bandOf(bands, last.value);
  const bandCls = (b: CourseBand | undefined, i: number): BandClass => (b && b === current ? "bc" : i % 2 ? "b1" : "b0");
  const laidBands = bands.map((b, i) => {
    const y0 = Y(b.to);
    const y1 = Y(b.from);
    const labelY = y1 - y0 >= 16 ? y1 - 6 : (y0 + y1) / 2 + 4;
    return { ...b, cls: bandCls(b, i), y0, y1, labelY };
  });

  const tickValues = [...new Set([min, ...bands.map((b) => b.from).filter((v) => v > min), max])].sort((a, b) => b - a);
  const ticks: { v: number; y: number }[] = [];
  for (const v of tickValues) {
    const y = Y(v);
    if (ticks.every((t) => Math.abs(t.y - y) >= TICK_GAP)) ticks.push({ v, y });
  }

  const base = points[0]!.value;
  const zone = rc && rc > 0 ? { y0: Y(Math.min(max, base + rc)), y1: Y(Math.max(min, base - rc)) } : null;

  const todayX = showToday ? X(today!) : null;
  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

  let lastShown = -Infinity;
  const raw = points.map((p, i) => {
    const x = X(p.t);
    const y = Y(p.value);
    const labelY = y - 10 < top + 12 ? y + 19 : y - 10;
    const idx = bands.indexOf(bandOf(bands, p.value) as CourseBand);
    const cls = idx >= 0 ? bandCls(bands[idx], idx) : "b0";
    return { x, y, labelY, cls, isToday: today !== undefined && sameDay(p.t, today), i };
  });
  // последняя дата всегда видна — это «сейчас»; остальные уступают ей место
  const lastX = raw.length ? raw[raw.length - 1]!.x : 0;
  const pts = raw.map((p, i) => {
    const isLast = i === raw.length - 1;
    const fits = p.x - lastShown >= DATE_GAP && (isLast || lastX - p.x >= DATE_GAP);
    const dateHidden = !(isLast || fits);
    if (!dateHidden) lastShown = p.x;
    return { x: p.x, y: p.y, labelY: p.labelY, cls: p.cls, isToday: p.isToday, dateHidden };
  });

  const clampX = (x: number) => Math.max(left + 4, Math.min(left + plotWidth - 4, x));
  const laidSignals = signals.filter((s) => s.t >= d0 && s.t <= d1).map((s) => ({ x: clampX(X(s.t)), label: s.label }));

  const bounds = [left, ...pts.slice(1).map((p, i) => (pts[i]!.x + p.x) / 2), left + plotWidth];
  const hits = pts.map((_, i) => ({ x0: bounds[i]!, x1: bounds[i + 1]! }));

  return {
    left,
    top,
    plotWidth,
    plotHeight,
    totalHeight,
    bands: laidBands,
    ticks,
    zone,
    todayX,
    futureX: todayX,
    pts,
    signals: laidSignals,
    hits,
  };
}
