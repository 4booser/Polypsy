/*
 * Глифы макета, которых нет в общем наборе.
 *
 * Набор в ui/index.tsx рисует штрихом 1.8 на сетке 24 — это значки рельсы и
 * кнопок панелей. На макете же «+» нарисован плотнее, каретка — залитый
 * треугольник 9×5. Подгонять общий набор под несколько знаков значило бы менять его на всех
 * экранах; заводить их заново в каждом экране уже случалось (каталог,
 * заключение и карточки людей рисовали свои копии), и разошлись бы они на
 * первой же правке замера.
 *
 * Все — `aria-hidden`: смысл им даёт кнопка, в которой они стоят
 * (aria-label у Button size="glyph"), а не сама картинка.
 */

import type { SVGProps } from "react";

/** «+» над списком: плюс набора (lucide), чуть плотнее штрихом — стоит один в квадрате 36 */
export function IconPlusThick() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} aria-hidden focusable="false">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />
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

/*
 * Знаки, стоящие в строке текста вместо символа.
 *
 * «✕», «⚠», «★», «↵», «⌘», «⧉» и подобные лежат вне подмножеств наших
 * шрифтов, и браузер рисовал их запасной гарнитурой — у macOS, Linux и
 * раннера CI она своя, и эталоны экранов краснели без правки кода (см.
 * test/fontCoverage.test.ts). Расширять подмножество Manrope здесь нельзя: в
 * самом Manrope этих знаков нет. Значок вместо символа — один контур везде.
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

