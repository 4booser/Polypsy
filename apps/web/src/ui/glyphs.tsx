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

import type { SVGProps } from "react";

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
 * Шестерёнка 24×24, залитая — открывает меню действий карточки, структуры
 * модели и документа заключения. Общий набор ui/index.tsx рисует контурные
 * значки 24×24 штрихом 1.8 — в ряд с ними она не встаёт.
 *
 * Было 27 (как «+» той же строки), стало 24: замер чернил глифа на кадрах
 * раздела людей даёт 25×25 с антиалиасом, то есть ровно 24 (f04 1395…1419 и
 * 166…190, f47 1382…1406 и 165…189). «+» при этом остаётся 27 — это разные
 * знаки и разные замеры, а не один размер на все глифы. Область нажатия 44
 * держит Button size="glyph" псевдоэлементом, и от видимого квадрата она не
 * зависит.
 */
/**
 * Шестерёнка 24, хотя кадры просят и 25, и 30.
 *
 * Замер по фиолетовым чернилам: f04, f30, f40 дают квадрат 25×25 (x
 * 1375…1399), а f05, f13 и f36 — 30×30 (x 1370…1399). Один и тот же знак в
 * одном и том же углу нарисован в макете двумя размерами, и одно число
 * обязано проиграть. Оставлено 24 — оно в пиксель от меньшей тройки, а
 * тянуть его к 30 значило бы разъехаться с четырьмя экранами раздела людей,
 * сведёнными по своим кадрам раньше. Записано здесь, чтобы следующая сверка
 * не «чинила» размер по f36 и не ломала f04/f30/f40.
 */
export function IconGear() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden focusable="false" className="size-[24px]" fill="currentColor">
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

/*
 * Знаки, стоящие в строке текста вместо символа.
 *
 * «✕», «⚠», «★», «↵», «⌘», «⧉» и подобные лежат вне подмножеств наших
 * шрифтов, и браузер рисовал их запасной гарнитурой — у macOS, Linux и
 * раннера CI она своя, и эталоны экранов краснели без правки кода (см.
 * test/fontCoverage.test.ts). Расширять подмножество Onest здесь нельзя: в
 * самом Onest этих знаков нет. Значок вместо символа — один контур везде.
 *
 * Размер — 1em, а не пиксели, как у знаков макета выше: символ занимал
 * кегль окружающего текста (14 px у чипа, микро-кегль у <kbd>, text-small у
 * списка замечаний), и значок встаёт на его место без замера под каждое.
 * Опущен на 0.15em — как строчный знак, а не как заглавная над базовой
 * линией; во flex-контейнерах это смещение не действует и не мешает.
 */
function TextGlyph({ children, ...attrs }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden focusable="false" className="inline-block align-[-0.15em]" {...attrs}>
      {children}
    </svg>
  );
}

/** «✕» закрытия — диалога, чипа, строки плана безопасности */
export function IconClose() {
  return (
    <TextGlyph fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </TextGlyph>
  );
}

/** «✖» ошибки в списке замечаний: тот же крест, но жирный — не спутать с закрытием */
export function IconCross() {
  return (
    <TextGlyph fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round">
      <path d="M5 5l14 14M19 5L5 19" />
    </TextGlyph>
  );
}

/** «⚠» предупреждения: треугольник с восклицательным знаком */
export function IconCaution() {
  return (
    <TextGlyph fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v5M12 17.5h.01" />
    </TextGlyph>
  );
}

/** «★» своего специалиста в записи на приём: залитая пятиконечная */
export function IconStar() {
  return (
    <TextGlyph fill="currentColor">
      <path d="M12 2.5l2.9 6.2 6.8.8-5 4.7 1.3 6.8L12 17.6 6 21l1.3-6.8-5-4.7 6.8-.8Z" />
    </TextGlyph>
  );
}

/** «↵» — Enter в подвале палитры команд */
export function IconEnter() {
  return (
    <TextGlyph fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 5v6a3 3 0 0 1-3 3H5" />
      <path d="M9 10l-4 4 4 4" />
    </TextGlyph>
  );
}

/** «⌘» — подпись клавиши в <kbd>; значок, а не буквы: так её печатает и сама клавиатура */
export function IconCommand() {
  return (
    <TextGlyph fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
    </TextGlyph>
  );
}

/** «⧉» дублирования пункта: два листа внахлёст */
export function IconCopy() {
  return (
    <TextGlyph fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </TextGlyph>
  );
}
