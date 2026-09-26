/**
 * Индекс достоверности изменения (RCI, Jacobson & Truax, 1991).
 *
 * Отвечает на вопрос: «сдвиг между двумя замерами — реальное изменение или
 * шум измерения?» Стандарт measurement-based care.
 *
 *   SEM   = SD · √(1 − r)         — стандартная ошибка измерения
 *   Sdiff = √(2 · SEM²)           — ошибка разности двух замеров
 *   RCI   = (x₂ − x₁) / Sdiff     — |RCI| > 1.96 ⇒ p < 0.05
 *
 * SD и r берутся из выборки (нормы шкалы или фактическая альфа) — оба
 * обязаны быть осмысленными, иначе честный ответ «посчитать нельзя», а не
 * ноль. Направление сдвига здесь нейтрально («вверх/вниз»): хорошо это или
 * плохо, знает только шкала — полярность интерпретируется на уровне норм.
 */

export interface ReliableChange {
  /** Сам индекс: сдвиг в единицах ошибки разности */
  rci: number;
  /**
   * Стандартная ошибка одного измерения в единицах шкалы.
   *
   * Отдаётся отдельно, а не выводится из sdiff вызывающим кодом: полоса
   * ошибки на графике строится именно по ней, и деление на √2 «где-то в
   * компоненте» — ровно то место, где однажды потеряется двойка.
   */
  sem: number;
  /** Ошибка разности двух замеров в единицах шкалы */
  sdiff: number;
  /** |RCI| превышает критерий */
  significant: boolean;
  direction: "up" | "down" | "flat";
}

export function reliableChange(
  first: number,
  last: number,
  sd: number,
  reliability: number,
  criterion = 1.96,
): ReliableChange | null {
  // r=1 дал бы нулевую ошибку и бесконечный индекс; r≤0 — измерения нет
  if (!Number.isFinite(sd) || sd <= 0) return null;
  if (!Number.isFinite(reliability) || reliability <= 0 || reliability >= 1) return null;

  const sem = sd * Math.sqrt(1 - reliability);
  const sdiff = Math.sqrt(2 * sem * sem);
  if (sdiff === 0) return null;

  const rci = (last - first) / sdiff;
  return {
    rci: Math.round(rci * 100) / 100,
    sem: Math.round(sem * 100) / 100,
    sdiff: Math.round(sdiff * 100) / 100,
    significant: Math.abs(rci) > criterion,
    direction: last > first ? "up" : last < first ? "down" : "flat",
  };
}

/**
 * Сколько накопленных прохождений нужно, чтобы SD и α перестали врать.
 *
 * Стандартное отклонение само по себе — оценка со своей погрешностью:
 * относительная ошибка s равна 1/√(2(n−1)) (Kenney & Keeping, 1951, §7.11).
 * На десяти наблюдениях это 24% — то есть SEM, а с ней и порог «перемена
 * больше погрешности», гуляет на четверть в обе стороны, и один и тот же
 * сдвиг объявляется то надёжным, то нет в зависимости от того, кто ещё успел
 * пройти методику на этой неделе. На тридцати — 13%, и это тот минимум, ниже
 * которого мы отдаём null и число недостающих прохождений, а не цифру.
 *
 * Отвергнутая альтернатива: брать SD из пособия. Она не подходит не потому,
 * что хуже статистически, а потому, что пособия писаны на другой популяции —
 * SD срочной службы и SD амбулаторного приёма различаются в разы, и RCI,
 * посчитанный по чужому разбросу, систематически завышает надёжность.
 */
export const MIN_RCI_SAMPLE = 30;

export interface MeasurementError {
  /** Стандартная ошибка одного измерения, в единицах шкалы */
  sem: number;
  /** Ошибка разности двух замеров: √2·SEM */
  sdiff: number;
  /**
   * Минимальная различимая перемена: меньший сдвиг неотличим от шума.
   *
   * Это тот же порог, что |RCI| > 1.96, только выраженный в баллах шкалы, —
   * и именно в таком виде он нужен специалисту: «три балла по этой шкале
   * ничего не значат» понятно без пересчёта, «RCI = 1.1» — нет.
   */
  mdc95: number;
}

/**
 * Ошибка измерения по классической теории тестов.
 *
 *   SEM   = SD·√(1 − α)        — Lord & Novick (1968), «Statistical Theories
 *                                of Mental Test Scores», гл. 3
 *   Sdiff = √(2·SEM²)          — Jacobson & Truax (1991), J Consult Clin
 *                                Psychol 59(1), 12–19
 *   MDC95 = 1.96·√2·SEM        — Weir (2005), J Strength Cond Res 19(1), 231–240
 *
 * Врёт, когда: наблюдений меньше MIN_RCI_SAMPLE (SD — шум), α вне (0;1)
 * (α ≥ 1 даёт нулевую ошибку и бесконечную уверенность, α ≤ 0 означает, что
 * измерения нет вовсе), SD ≤ 0 (нулевой разброс — делить не на что).
 * Во всех этих случаях null, а не приблизительное значение.
 */
export function measurementError(sd: number, reliability: number): MeasurementError | null {
  if (!Number.isFinite(sd) || sd <= 0) return null;
  if (!Number.isFinite(reliability) || reliability <= 0 || reliability >= 1) return null;

  const sem = sd * Math.sqrt(1 - reliability);
  const sdiff = Math.sqrt(2 * sem * sem);
  if (!(sdiff > 0)) return null;

  return {
    sem: Math.round(sem * 100) / 100,
    sdiff: Math.round(sdiff * 100) / 100,
    mdc95: Math.round(1.96 * sdiff * 100) / 100,
  };
}

/**
 * Куда человек пришёл по критериям Jacobson & Truax (1991).
 *
 * `recovered` — «одужав»: перемена надёжна И замер вышел из клинической
 * полосы. Оба условия обязательны: надёжный сдвиг внутри тяжёлой полосы —
 * это ещё не выздоровление, а выход из полосы на шум измерения — не событие.
 * `improved` / `deteriorated` — надёжная перемена без смены полосы.
 * `unchanged` — |RCI| ≤ 1.96: сдвиг не отличается от погрешности.
 */
export type ChangeClass = "recovered" | "improved" | "unchanged" | "deteriorated";

export interface ChangeClassInput {
  rci: number;
  /**
   * Улучшение — это движение балла ВНИЗ?
   *
   * null означает «полярность шкалы неизвестна», и тогда классификации нет
   * вовсе. Назвать сдвиг улучшением, не зная, что означает рост балла, —
   * ровно та ошибка, ради которой полярность и вынесена в параметр: у СР-45
   * единица худший результат, а пятёрка лучший, и «балл вырос» там значит
   * обратное тому, что значит в шкале тревоги.
   */
  higherIsWorse: boolean | null;
  /** Первый замер был в клинической полосе (moderate/severe)? null — полосы нет */
  firstClinical: boolean | null;
  lastClinical: boolean | null;
  criterion?: number;
}

export function classifyChange(input: ChangeClassInput): ChangeClass | null {
  const { rci, higherIsWorse, firstClinical, lastClinical, criterion = 1.96 } = input;
  if (!Number.isFinite(rci)) return null;
  if (higherIsWorse === null) return null;

  if (Math.abs(rci) <= criterion) return "unchanged";

  // знак RCI — это движение балла; улучшение зависит от полярности шкалы
  const improved = higherIsWorse ? rci < 0 : rci > 0;
  if (!improved) return "deteriorated";

  /*
   * Выход из клинической полосы требует знать обе полосы. Если хоть одна
   * неизвестна — это «покращення», а не «одужав»: выздоровление объявляют по
   * факту, а не по умолчанию, и пустая полоса у первого замера значит, что
   * сравнивать не с чем.
   */
  return firstClinical === true && lastClinical === false ? "recovered" : "improved";
}

/**
 * Полярность шкалы по её же полосам: растёт ли тяжесть вместе с баллом.
 *
 * Считается по данным самой методики, а не задаётся флагом в справочнике:
 * флаг пришлось бы проставлять руками на каждой из полутора сотен шкал
 * каталога, и он разошёлся бы с полосами в первый же день правки норм.
 *
 * null — полосы не дают ответа: их меньше двух, тяжесть у всех одинаковая
 * или она меняется немонотонно (U-образные шкалы, где плохо и внизу, и
 * вверху). Для последних «улучшение» вообще не определено одним числом.
 */
export function polarityOfBands(
  bands: { minScore: number; maxScore: number; severity: string }[],
): boolean | null {
  const rank: Record<string, number> = { none: 0, mild: 1, moderate: 2, severe: 3 };
  const points = bands
    .map((b) => ({ at: (b.minScore + b.maxScore) / 2, sev: rank[b.severity] }))
    .filter((p): p is { at: number; sev: number } => p.sev !== undefined)
    .sort((a, b) => a.at - b.at);
  if (points.length < 2) return null;

  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i++) {
    const diff = points[i]!.sev - points[i - 1]!.sev;
    if (diff > 0) up += 1;
    if (diff < 0) down += 1;
  }
  if (up > 0 && down > 0) return null; // немонотонно — одним знаком не описать
  if (up === 0 && down === 0) return null; // тяжесть одна и та же во всех полосах
  return up > 0;
}

/** Клиническая ли полоса: с moderate начинается то, что разбирают */
export function isClinicalSeverity(severity: string | null): boolean | null {
  if (severity === null) return null;
  return severity === "moderate" || severity === "severe";
}
