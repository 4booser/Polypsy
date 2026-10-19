/*
 * Глифы, которых нет в общем наборе: знаки, стоящие в строке текста вместо
 * символа. Заводить их заново в каждом экране уже случалось (каталог,
 * заключение и карточки людей рисовали свои копии), и разошлись бы они на
 * первой же правке замера.
 *
 * Все — `aria-hidden`: смысл им даёт кнопка или подпись, в которой они
 * стоят, а не сама картинка.
 */

import type { SVGProps } from "react";

/*
 * Знаки, стоящие в строке текста вместо символа.
 *
 * «✕», «⚠», «★», «↵», «⌘», «⧉» и подобные лежат вне подмножеств наших
 * шрифтов, и браузер рисовал их запасной гарнитурой — у macOS, Linux и
 * раннера CI она своя, и эталоны экранов краснели без правки кода (см.
 * test/fontCoverage.test.ts). Расширять подмножество Manrope здесь нельзя: в
 * самом Manrope этих знаков нет. Значок вместо символа — один контур везде.
 *
 * Размер — 1em, а не пиксели: символ занимал
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

