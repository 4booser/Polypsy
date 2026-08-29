/**
 * Как читать ячейку тепловой карты пунктов.
 *
 * Два независимых признака, а не один «индекс небрежности». Свести их в одно
 * число значит спрятать от человека ровно то, на что он смотрит: слишком
 * быстрый ответ и длинная серия одинаковых — разные вещи с разными причинами.
 * Быстро отвечают, когда пункт очевиден; серию даёт и добросовестный человек,
 * у которого действительно всё «нет».
 *
 * Поэтому здесь не «плохо/хорошо», а «на что посмотреть».
 */

export type CellMark = "none" | "fast" | "run" | "both" | "missing";

export interface QualityCell {
  answered: boolean;
  /** Доля от медианы этого пункта; null — времени нет */
  rel: number | null;
  /** Длина серии одинаковых ответов, в которую входит пункт */
  run: number;
}

export interface QualityThresholds {
  /**
   * Во сколько раз быстрее медианы считается «слишком быстро».
   *
   * Пятая часть, а не половина: половина медианы — это обычный разброс между
   * людьми, и метка на половине ячеек перестаёт что-либо значить.
   */
  fastRatio: number;
  /**
   * С какой длины серия одинаковых ответов заслуживает взгляда.
   *
   * Восемь, а не три: в опроснике на двести пунктов серия из трёх встречается
   * у всех, и порог в три превратил бы карту в сплошную заливку.
   */
  runLength: number;
}

export const DEFAULT_THRESHOLDS: QualityThresholds = { fastRatio: 0.2, runLength: 8 };

export function markOf(cell: QualityCell, t: QualityThresholds = DEFAULT_THRESHOLDS): CellMark {
  if (!cell.answered) return "missing";
  const fast = cell.rel !== null && cell.rel < t.fastRatio;
  const run = cell.run >= t.runLength;
  if (fast && run) return "both";
  if (fast) return "fast";
  if (run) return "run";
  return "none";
}

/**
 * Сводка по строке — сколько пунктов помечено.
 *
 * Нужна для сортировки: на двухстах пунктах глазами строку не оценить, а
 * сортировка по числу меток ставит наверх то, что стоит открыть.
 */
export function rowSummary(
  cells: QualityCell[],
  t: QualityThresholds = DEFAULT_THRESHOLDS,
): { fast: number; run: number; missing: number } {
  let fast = 0;
  let run = 0;
  let missing = 0;
  for (const cell of cells) {
    const mark = markOf(cell, t);
    if (mark === "missing") missing++;
    if (mark === "fast" || mark === "both") fast++;
    if (mark === "run" || mark === "both") run++;
  }
  return { fast, run, missing };
}
