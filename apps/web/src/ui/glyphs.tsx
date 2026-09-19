/*
 * Глифы макета, которые в общий набор ui/index.tsx не встают.
 *
 * Тот набор рисует контурные значки 24×24 штрихом 1.8 для строк меню. На
 * кадрах макета «+» нарисован штрихом 5 в квадрате 27 (f08, f11, f38),
 * шестерёнка — залитая и того же размера (f15, f38), каретка — залитый
 * треугольник 9×5, та же, что у селекта. Подгонять общий набор под три знака
 * значило бы менять его на всех экранах; заводить их заново в каждом экране,
 * где они стоят, — уже случилось дважды (каталог и заключение рисовали свои
 * копии), и третья копия в разделе аналитики стала бы поводом собрать их
 * здесь.
 */

/** «+» над списком: штрих 5 в квадрате 27 — замер кадра */
export function IconPlusThick() {
  return (
    <svg viewBox="0 0 27 27" width={27} height={27} aria-hidden focusable="false">
      <path d="M13.5 2.5v22M2.5 13.5h22" stroke="currentColor" strokeWidth={5} />
    </svg>
  );
}

/** Каретка у крошки и у селекта: залитый треугольник 9×5 */
export function IconCaret() {
  return (
    <svg viewBox="0 0 9 5" width={9} height={5} aria-hidden focusable="false">
      <path d="M0 0h9L4.5 5Z" fill="currentColor" />
    </svg>
  );
}

/** «⋯» действий строки: три точки, залитые */
export function IconDots() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} aria-hidden focusable="false" fill="currentColor">
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="12" cy="12" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
    </svg>
  );
}

/** Шестерёнка 27×27, залитая — замер кадров f15 и f38 */
export function GearGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" className="size-[27px]" fill="currentColor">
      <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3.3H9l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h6l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.5 1 2-3.5ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
    </svg>
  );
}
