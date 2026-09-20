/*
 * Глифы макета, которых нет в общем наборе.
 *
 * Набор в ui/index.tsx рисует штрихом 1.8 на сетке 24 — это значки рельсы и
 * кнопок панелей. На макете же «+» нарисован штрихом 5 в квадрате 27 (f05,
 * f08, f11, f38), сердце — контуром 24, шестерёнка — залитая 27 (f15, f33,
 * f38), каретка — залитый треугольник 9×5, «⋯» — три залитые точки.
 * Подгонять общий набор под несколько знаков значило бы менять его на всех
 * экранах; заводить их заново в каждом экране уже случалось (каталог,
 * заключение и карточки людей рисовали свои копии), и разошлись бы они на
 * первой же правке замера.
 *
 * Все — `aria-hidden`: смысл им даёт кнопка, в которой они стоят
 * (aria-label у Button size="glyph"), а не сама картинка.
 */

/** «+» над списком — штрих 5 в квадрате 27, как на макете */
export function IconPlusThick() {
  return (
    <svg viewBox="0 0 27 27" width={27} height={27} aria-hidden focusable="false">
      <path d="M13.5 2.5v22M2.5 13.5h22" stroke="currentColor" strokeWidth={5} />
    </svg>
  );
}

/**
 * Сердце: контур — не обрана, заливка — обрана. Одна фигура, меняется только
 * заливка: так глаз ловит переход, а не два разных знака.
 */
export function IconHeart({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={24} height={24} aria-hidden focusable="false">
      <path
        d="M12 21s-7.5-4.6-9.6-9.2C1 8.6 3 5 6.6 5c2 0 3.6 1.2 5.4 3.2C13.8 6.2 15.4 5 17.4 5 21 5 23 8.6 21.6 11.8 19.5 16.4 12 21 12 21Z"
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Шестерёнка 27×27, залитая — замер кадров f15, f33, f38; открывает меню
 * действий карточки, структуры модели и документа заключения. Общий набор
 * ui/index.tsx рисует контурные значки 24×24 штрихом 1.8 — в ряд с ними
 * она не встаёт.
 */
export function IconGear() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" className="size-[27px]" fill="currentColor">
      <path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.5 7.5 0 0 0-1.7-1L15 3.3H9l-.4 2.6a7.5 7.5 0 0 0-1.7 1l-2.5-1-2 3.5L4.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.5 7.5 0 0 0 1.7 1l.4 2.6h6l.4-2.6a7.5 7.5 0 0 0 1.7-1l2.5 1 2-3.5ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z" />
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

/**
 * «▸» раскрывающегося раздела конструктора: треугольник вправо, повёрнутый
 * на 90° у открытого. Символа U+25B8 в Onest нет, а системный запасной шрифт
 * рисует его по-разному на macOS и Linux — эталоны краснели от смены образа
 * раннера. Свой контур одинаков везде.
 */
export function IconDisclosure() {
  return (
    <svg viewBox="0 0 5 8" width={5} height={8} aria-hidden focusable="false">
      <path d="M0 0l5 4-5 4Z" fill="currentColor" />
    </svg>
  );
}

