/**
 * Стат-ядро медицинской аналитики (этап 8.2 плана).
 *
 * Правила модуля: только чистые функции; каждая — с золотым тестом на
 * примере, посчитанном руками; невычислимые случаи возвращают null, а не
 * ноль. Ни одна из этих формул не имеет права жить в маршруте.
 */

/* ── Mantel–Haenszel: дифференциальное функционирование пунктов ── */

/** Одна страта суммарного балла: 2×2 (группа × ответ по ключу) */
export interface MhStratum {
  /** Референсная группа: по ключу / не по ключу */
  refYes: number;
  refNo: number;
  /** Фокальная группа */
  focalYes: number;
  focalNo: number;
}

export interface MhResult {
  chi2: number;
  /** Общее отношение шансов αMH */
  alphaMH: number;
  /** ΔMH = −2.35·ln(αMH): метрика ETS в дельта-единицах */
  deltaMH: number;
  /** Классификация ETS: A — нет DIF, B — умеренный, C — выраженный */
  etsClass: "A" | "B" | "C";
  /** χ² > 3.84 (p < 0.05, df=1) */
  significant: boolean;
}

export function mantelHaenszel(strata: MhStratum[]): MhResult | null {
  /*
   * Поправка Хальдейна–Анскомба. При полном разделении (одна группа отвечает
   * по ключу всегда, другая никогда) отношение шансов вырождается в 0 или ∞,
   * и наивная формула вернула бы «не могу посчитать» — тогда как это,
   * наоборот, максимально выраженный DIF. Добавляем 0.5 к каждой ячейке
   * только в вырожденном случае: на обычных данных поправка сместила бы
   * оценку без нужды.
   */
  // пустые страты выкидываем до поправки: иначе +0.5 «оживил» бы их
  // и вернул бы αMH=1 там, где данных нет вовсе
  const filled = strata.filter((s) => s.refYes + s.refNo + s.focalYes + s.focalNo > 0);
  if (filled.length === 0) return null;

  const degenerate = filled.some(
    (s) => s.refYes === 0 || s.refNo === 0 || s.focalYes === 0 || s.focalNo === 0,
  );
  const work = degenerate
    ? filled.map((s) => ({
        refYes: s.refYes + 0.5,
        refNo: s.refNo + 0.5,
        focalYes: s.focalYes + 0.5,
        focalNo: s.focalNo + 0.5,
      }))
    : filled;

  let sumA = 0;
  let sumE = 0;
  let sumV = 0;
  let sumAD = 0;
  let sumBC = 0;

  for (const s of work) {
    const a = s.refYes;
    const b = s.refNo;
    const c = s.focalYes;
    const d = s.focalNo;
    const N = a + b + c + d;
    if (N < 2) continue;
    const rowRef = a + b;
    const colYes = a + c;
    sumA += a;
    sumE += (rowRef * colYes) / N;
    sumV += (rowRef * (c + d) * colYes * (b + d)) / (N * N * (N - 1));
    sumAD += (a * d) / N;
    sumBC += (b * c) / N;
  }

  if (sumV === 0 || sumBC === 0) return null; // вырождено: нечего сравнивать

  // поправка на непрерывность 0.5 — классическая форма MH χ²
  const chi2 = Math.max(0, Math.abs(sumA - sumE) - 0.5) ** 2 / sumV;
  const alphaMH = sumAD / sumBC;
  if (!Number.isFinite(alphaMH) || alphaMH <= 0) return null;
  const deltaMH = -2.35 * Math.log(alphaMH);
  const significant = chi2 > 3.84;

  const abs = Math.abs(deltaMH);
  const etsClass: MhResult["etsClass"] =
    abs < 1 || !significant ? "A" : abs > 1.5 ? "C" : "B";

  return {
    chi2: round2(chi2),
    alphaMH: round(alphaMH, 3),
    deltaMH: round2(deltaMH),
    etsClass,
    significant,
  };
}

/* ── Прямая возрастно-половая стандартизация ── */

export interface StandardizeInput {
  /** Показатель в страте наблюдаемой группы (например, доля высокого риска) */
  rate: number;
  /** Размер той же страты в СТАНДАРТНОЙ популяции */
  standardWeight: number;
}

/**
 * Прямая стандартизация: «какой была бы доля в группе, будь её структура
 * стандартной». Страты без веса в стандарте не вносят ничего.
 */
export function directStandardize(strata: StandardizeInput[]): number | null {
  const totalWeight = strata.reduce((s, x) => s + x.standardWeight, 0);
  if (totalWeight <= 0) return null;
  const weighted = strata.reduce((s, x) => s + x.rate * x.standardWeight, 0);
  return round(weighted / totalWeight, 4);
}

/* ── Контрольные карты ── */

export interface PChartPoint {
  /** Наблюдений в периоде */
  n: number;
  /** Из них «событий» (высокий риск) */
  x: number;
}

export interface PChartRow {
  p: number;
  ucl: number;
  lcl: number;
  beyondLimits: boolean;
  /** 8 подряд точек по одну сторону центра (правило Western Electric №4) */
  runSignal: boolean;
}

export function pChart(points: PChartPoint[]): { center: number; rows: PChartRow[] } | null {
  const totalN = points.reduce((s, p) => s + p.n, 0);
  if (totalN === 0) return null;
  const center = points.reduce((s, p) => s + p.x, 0) / totalN;

  let runSide: 1 | -1 | 0 = 0;
  let runLen = 0;

  const rows = points.map((pt) => {
    const p = pt.n > 0 ? pt.x / pt.n : 0;
    const sigma = pt.n > 0 ? Math.sqrt((center * (1 - center)) / pt.n) : 0;
    const ucl = Math.min(1, center + 3 * sigma);
    const lcl = Math.max(0, center - 3 * sigma);

    const side: 1 | -1 | 0 = p > center ? 1 : p < center ? -1 : 0;
    if (side !== 0 && side === runSide) runLen += 1;
    else {
      runSide = side;
      runLen = side === 0 ? 0 : 1;
    }

    return {
      p: round(p, 4),
      ucl: round(ucl, 4),
      lcl: round(lcl, 4),
      beyondLimits: pt.n > 0 && (p > ucl || p < lcl),
      runSignal: runLen >= 8,
    };
  });

  return { center: round(center, 4), rows };
}

/** EWMA-сглаживание: z_i = λ·x_i + (1−λ)·z_{i−1}; устойчиво при малых n */
export function ewma(values: number[], lambda = 0.2): number[] {
  if (values.length === 0) return [];
  const out: number[] = [];
  let z = values[0]!;
  for (const x of values) {
    z = lambda * x + (1 - lambda) * z;
    out.push(round(z, 4));
  }
  return out;
}

/* ── ROC-калибровка порогов ── */

export interface RocPoint {
  threshold: number;
  tpr: number;
  fpr: number;
}

export interface RocResult {
  auc: number;
  points: RocPoint[];
  /** Порог с максимальным индексом Юдена (TPR − FPR) */
  bestThreshold: number;
  bestSensitivity: number;
  bestSpecificity: number;
}

/**
 * ROC по парам (балл, исход). Соглашение: выше балл — больше подозрение.
 * Порог трактуется как «положительный при score ≥ threshold».
 */
export function roc(pairs: { score: number; positive: boolean }[]): RocResult | null {
  const pos = pairs.filter((p) => p.positive).length;
  const neg = pairs.length - pos;
  if (pos === 0 || neg === 0) return null; // без обоих исходов кривой нет

  const sorted = [...pairs].sort((a, b) => b.score - a.score);
  const points: RocPoint[] = [];
  let tp = 0;
  let fp = 0;
  let auc = 0;
  let prevFpr = 0;
  let prevTpr = 0;
  let i = 0;

  while (i < sorted.length) {
    const threshold = sorted[i]!.score;
    // все с одинаковым баллом пересекают порог одновременно
    while (i < sorted.length && sorted[i]!.score === threshold) {
      if (sorted[i]!.positive) tp++;
      else fp++;
      i++;
    }
    const tpr = tp / pos;
    const fpr = fp / neg;
    auc += ((fpr - prevFpr) * (tpr + prevTpr)) / 2; // трапеция
    points.push({ threshold, tpr: round(tpr, 4), fpr: round(fpr, 4) });
    prevFpr = fpr;
    prevTpr = tpr;
  }

  let best = points[0]!;
  for (const p of points) {
    if (p.tpr - p.fpr > best.tpr - best.fpr) best = p;
  }

  return {
    auc: round(auc, 4),
    points,
    bestThreshold: best.threshold,
    bestSensitivity: round(best.tpr, 4),
    bestSpecificity: round(1 - best.fpr, 4),
  };
}

/* ── Тест-ретест: ICC(2,1) для двух замеров ── */

/**
 * Двухфакторная случайная модель, единичное измерение. Формула через
 * средние квадраты для k=2 «случаев» (замеров).
 */
export function icc21(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 3) return null;
  const k = 2;

  const grand = pairs.flat().reduce((s, v) => s + v, 0) / (n * k);
  const rowMeans = pairs.map(([a, b]) => (a + b) / 2);
  const colMeans = [
    pairs.reduce((s, p) => s + p[0], 0) / n,
    pairs.reduce((s, p) => s + p[1], 0) / n,
  ];

  const ssRows = k * rowMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  const ssCols = n * colMeans.reduce((s, m) => s + (m - grand) ** 2, 0);
  const ssTotal = pairs.flat().reduce((s, v) => s + (v - grand) ** 2, 0);
  const ssErr = ssTotal - ssRows - ssCols;

  const msr = ssRows / (n - 1);
  const msc = ssCols / (k - 1);
  const mse = ssErr / ((n - 1) * (k - 1));

  const denom = msr + (k - 1) * mse + (k * (msc - mse)) / n;
  if (denom === 0) return null;
  return round((msr - mse) / denom, 3);
}

/* ── Дрейф выборки: PSI ── */

/**
 * Population Stability Index двух распределений по одинаковым корзинам.
 * Ориентиры: < 0.1 — стабильно, 0.1–0.2 — заметный сдвиг, > 0.2 — существенный.
 */
export function psi(expected: number[], actual: number[]): number | null {
  if (expected.length !== actual.length || expected.length === 0) return null;
  const sumE = expected.reduce((s, v) => s + v, 0);
  const sumA = actual.reduce((s, v) => s + v, 0);
  if (sumE === 0 || sumA === 0) return null;

  const eps = 1e-4; // нулевые корзины не должны давать бесконечность
  let total = 0;
  for (let i = 0; i < expected.length; i++) {
    const pe = Math.max(expected[i]! / sumE, eps);
    const pa = Math.max(actual[i]! / sumA, eps);
    total += (pa - pe) * Math.log(pa / pe);
  }
  return round(total, 4);
}

/* ── Person-fit: нормированные ошибки Гуттмана ── */

/**
 * items — бинарные ответы человека, упорядоченные ОТ ЛЁГКОГО К ТРУДНОМУ
 * (по доле срабатывания в выборке). Ошибка — пара «трудный сработал,
 * лёгкий нет». Норма — максимум ошибок при данном суммарном балле.
 * 0 — идеально согласованный профиль; ~0.5 — случайный; ближе к 1 — инверсия.
 */
export function guttmanErrorsNormed(items: (0 | 1)[]): number | null {
  const n = items.length;
  const total = items.reduce<number>((s, v) => s + v, 0);
  if (n < 4 || total === 0 || total === n) return null; // крайние профили не информативны

  let errors = 0;
  for (let easy = 0; easy < n; easy++) {
    for (let hard = easy + 1; hard < n; hard++) {
      if (items[hard] === 1 && items[easy] === 0) errors++;
    }
  }
  const maxErrors = total * (n - total);
  return round(errors / maxErrors, 3);
}

/* ── Квантили (для перцентильных карт) ── */

/** Линейная интерполяция (тип 7, как в R по умолчанию) */
export function quantile(values: number[], q: number): number | null {
  if (values.length === 0 || q < 0 || q > 1) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac, 4);
}

/* ── служебное ── */

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
function round2(v: number): number {
  return round(v, 2);
}
