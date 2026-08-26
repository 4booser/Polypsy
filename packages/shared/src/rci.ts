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
    sdiff: Math.round(sdiff * 100) / 100,
    significant: Math.abs(rci) > criterion,
    direction: last > first ? "up" : last < first ? "down" : "flat",
  };
}
