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
  /** labeled — подписывать ли значение у точки: при густом ряде только края и крайние значения */
  pts: { x: number; y: number; labelY: number; cls: BandClass; isToday: boolean; dateHidden: boolean; labeled: boolean }[];
  /**
   * Сигнал: метка на оси (x) и подпись рядом. Подпись встаёт туда, где не
   * налезает на слово полосы: справа от метки, слева, строкой выше; нигде не
   * помещается — label пустой, остаётся метка (что она значит, говорит легенда).
   */
  signals: { x: number; label: string; labelX: number; labelY: number; anchor: "start" | "end" }[];
  hits: { x0: number; x1: number }[];
}

const DAY = 86_400_000;
/** Подписи дат ближе этого налезают друг на друга при кегле 11 */
const DATE_GAP = 38;
/** Деления оси ближе этого сливаются в одно число */
const TICK_GAP = 12;
/** До стольких замеров подписан каждый; гуще — только первый, последний, наибольший и наименьший */
const LABEL_ALL = 6;
/**
 * Черта «сьогодні» ближе этого к последнему замеру легла бы на его точку
 * (выбранная точка — с подложкой радиусом 10) и разрезала бы её подпись.
 */
const TODAY_GAP = 10;
/** Кегль подписей полос и сигнала */
const LABEL_SIZE = 11;
/** Метка сигнала на оси — квадрат 9 × 9 с центром на нижней границе поля */
const MARK = 4.5;

/**
 * Ширина подписи без измерения: средний знак Manrope жирного начертания
 * кегля 11 — около 6,3 px, берём с запасом. Ошибка в большую сторону стоит
 * только лишнего сдвига подписи, в меньшую — наложения.
 */
export function labelWidth(text: string, size = LABEL_SIZE): number {
  return text.length * size * 0.62;
}

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const overlaps = (a: Box, b: Box, pad = 3) =>
  a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;

/** Рамка строки текста кегля 11 по базовой линии: выносной элемент вверх 9, вниз 3 */
const textBox = (x0: number, x1: number, baseline: number): Box => ({ x0, x1, y0: baseline - 9, y1: baseline + 3 });

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
  axisLabel = String,
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
  /** Подпись деления оси — та же, что рисует график: по её ширине отводится место слева */
  axisLabel?: (v: number) => string;
}): CourseLayout {
  const right = 4;
  const top = 26;
  const totalHeight = top + plotHeight + 24;
  const span = Math.max(1e-9, max - min);
  const Y = (v: number) => top + plotHeight * (1 - (Math.max(min, Math.min(max, v)) - min) / span);

  const tickValues = [...new Set([min, ...bands.map((b) => b.from).filter((v) => v > min), max])].sort((a, b) => b - a);
  const ticks: { v: number; y: number }[] = [];
  for (const v of tickValues) {
    const y = Y(v);
    if (ticks.every((t) => Math.abs(t.y - y) >= TICK_GAP)) ticks.push({ v, y });
  }
  /*
   * Поле начинается после самой широкой подписи деления. Было 26 всегда —
   * хватало на «27», а у долей «0,75» обрезалось до «,75» у края экрана.
   */
  const left = Math.max(26, Math.ceil(Math.max(0, ...ticks.map((t) => labelWidth(axisLabel(t.v)))) + 8));
  const plotWidth = Math.max(80, width - left - right);

  const ts = points.map((p) => p.t);
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const range = t1 - t0;
  const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
  /*
   * «Сьогодні» рисуется, только если она недалеко за последним замером:
   * полгода тишины после курса сжали бы все замеры в левый угол ради одной
   * вертикальной черты.
   *
   * И только если она не ложится на сам последний замер. Замер сегодняшний —
   * черта шла ровно через его точку и число, а «сегодня» уже сказано жирной
   * датой под осью; замер вчерашний на долгом курсе — та же черта в пикселе
   * от точки. Тогда черты нет, и поле кончается на последнем замере.
   */
  const domain = (withToday: boolean) => {
    const tEnd = withToday ? Math.max(t1, today!) : t1;
    const pad = Math.max((tEnd - t0) * 0.06, DAY);
    return { d0: t0 - pad, d1: tEnd + pad };
  };
  const at = (t: number, d: { d0: number; d1: number }) => left + (plotWidth * (t - d.d0)) / (d.d1 - d.d0);
  let showToday =
    today !== undefined && today >= t0 && today - t1 <= Math.max(range * 0.5, 14 * DAY) && !sameDay(t1, today);
  let dom = domain(showToday);
  if (showToday && at(today!, dom) - at(t1, dom) < TODAY_GAP) {
    showToday = false;
    dom = domain(false);
  }
  const { d0, d1 } = dom;
  const X = (t: number) => (points.length === 1 && !showToday ? left + plotWidth / 2 : at(t, dom));

  const last = points[points.length - 1]!;
  const current = bandOf(bands, last.value);
  const bandCls = (b: CourseBand | undefined, i: number): BandClass => (b && b === current ? "bc" : i % 2 ? "b1" : "b0");

  // метки сигналов на оси — до слов полос: слово уступает метке, а не накрывает её
  const clampX = (x: number) => Math.max(left + 4, Math.min(left + plotWidth - 4, x));
  const axisY = top + plotHeight;
  const marks = signals.filter((s) => s.t >= d0 && s.t <= d1).map((s) => ({ x: clampX(X(s.t)), label: s.label }));
  const markBoxes = marks.map((m): Box => ({ x0: m.x - MARK, x1: m.x + MARK, y0: axisY - MARK, y1: axisY + MARK }));

  /*
   * Слово полосы — у правого края, у нижней границы полосы. Нижняя граница
   * нижней полосы — это ось, где стоят метки сигналов, а сигнал обычно
   * свежий, то есть справа: слово садилось на красный квадрат. Над меткой
   * слово поднимается настолько, чтобы её не касаться.
   */
  const wordRight = left + plotWidth - 6;
  const laidBands = bands.map((b, i) => {
    const y0 = Y(b.to);
    const y1 = Y(b.from);
    let labelY = y1 - y0 >= 16 ? y1 - 6 : (y0 + y1) / 2 + 4;
    if (b.label) {
      const word = textBox(wordRight - labelWidth(b.label), wordRight, labelY);
      const under = markBoxes.filter((m) => overlaps(word, m, 1));
      if (under.length) labelY = Math.min(labelY, Math.min(...under.map((m) => m.y0)) - 5);
    }
    return { ...b, cls: bandCls(b, i), y0, y1, labelY };
  });
  const wordBoxes = laidBands.filter((b) => b.label).map((b) => textBox(wordRight - labelWidth(b.label), wordRight, b.labelY));

  /*
   * Подпись сигнала — у метки, но не поверх слова полосы: справа от метки,
   * слева, строкой выше справа и слева. Нигде не помещается — подписи нет,
   * метка остаётся, а что она значит, говорит легенда под графиком.
   */
  const placed: Box[] = [];
  const laidSignals = marks.map((m) => {
    const w = labelWidth(m.label);
    const base = axisY - 7;
    const tries: { anchor: "start" | "end"; x: number; y: number }[] = [
      { anchor: "start", x: m.x + 9, y: base },
      { anchor: "end", x: m.x - 9, y: base },
      { anchor: "start", x: m.x + 9, y: base - 14 },
      { anchor: "end", x: m.x - 9, y: base - 14 },
    ];
    const fit = m.label
      ? tries.find((p) => {
          const x0 = p.anchor === "start" ? p.x : p.x - w;
          const box = textBox(x0, x0 + w, p.y);
          if (box.x0 < left + 4 || box.x1 > left + plotWidth - 4) return false;
          return ![...wordBoxes, ...placed].some((o) => overlaps(box, o));
        })
      : undefined;
    if (!fit) return { x: m.x, label: "", labelX: m.x, labelY: base, anchor: "start" as const };
    const x0 = fit.anchor === "start" ? fit.x : fit.x - w;
    placed.push(textBox(x0, x0 + w, fit.y));
    return { x: m.x, label: m.label, labelX: fit.x, labelY: fit.y, anchor: fit.anchor };
  });

  const base = points[0]!.value;
  const zone = rc && rc > 0 ? { y0: Y(Math.min(max, base + rc)), y1: Y(Math.max(min, base - rc)) } : null;

  const todayX = showToday ? X(today!) : null;

  let lastShown = -Infinity;
  const raw = points.map((p, i) => {
    const x = X(p.t);
    const y = Y(p.value);
    const labelY = y - 10 < top + 12 ? y + 19 : y - 10;
    const idx = bands.indexOf(bandOf(bands, p.value) as CourseBand);
    const cls = idx >= 0 ? bandCls(bands[idx], idx) : "b0";
    return { x, y, labelY, cls, isToday: today !== undefined && sameDay(p.t, today), i };
  });
  /*
   * Число у каждой точки превращает график в таблицу, а при пятнадцати
   * замерах подписи налезают друг на друга. Густой ряд подписан по краям и
   * в крайних значениях — остальное по нажатию на точку.
   */
  const values = points.map((p) => p.value);
  const hi = values.indexOf(Math.max(...values));
  const lo = values.indexOf(Math.min(...values));
  const keep = new Set([0, points.length - 1, hi, lo]);
  // последняя дата всегда видна — это «сейчас»; остальные уступают ей место
  const lastX = raw.length ? raw[raw.length - 1]!.x : 0;
  const pts = raw.map((p, i) => {
    const isLast = i === raw.length - 1;
    const fits = p.x - lastShown >= DATE_GAP && (isLast || lastX - p.x >= DATE_GAP);
    const dateHidden = !(isLast || fits);
    if (!dateHidden) lastShown = p.x;
    const labeled = points.length <= LABEL_ALL || keep.has(i);
    return { x: p.x, y: p.y, labelY: p.labelY, cls: p.cls, isToday: p.isToday, dateHidden, labeled };
  });

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
