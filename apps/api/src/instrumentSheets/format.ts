/**
 * Язык и числа листов сверки.
 *
 * Листы — документация для психолога заказчика, а не фразы, которые сервер
 * собирает человеку в интерфейсе: поэтому текст здесь стоит прямо в коде на
 * двух языках (как тексты методик в instruments/ и документация OpenAPI), а
 * не в словаре сервера. Сторож сырых строк (apps/api/test/noRawStrings.test.ts)
 * этот каталог и не охраняет — по той же причине, что и instruments/.
 *
 * Английского листа нет сознательно: у методик нет английского текста
 * пунктов (CONTENT_LANGS), и лист «по-английски» описывал бы инструмент,
 * которого в системе не существует.
 */

export type SheetLang = "uk" | "ru";
export const SHEET_LANGS: SheetLang[] = ["uk", "ru"];

/** Пара «украинский, русский» — так же, как пункты лежат в методиках */
export interface Loc {
  uk: string;
  ru: string;
}

export const loc = (uk: string, ru: string): Loc => ({ uk, ru });

/** Выбор по языку листа: `s(lang)("Пункти", "Пункты")` */
export const pick =
  (lang: SheetLang) =>
  (uk: string, ru: string): string =>
    lang === "uk" ? uk : ru;

/**
 * Число так, как его пишут в пособии: запятая, без хвостовых нулей, настоящий
 * минус. Точность — три знака: столько держит движок (computeProfile
 * округляет сырые и доли до тысячных, T — до десятых).
 */
export function num(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  const rounded = Math.round(x * 1000) / 1000;
  const text = String(Math.abs(rounded)).replace(".", ",");
  return rounded < 0 ? `−${text}` : text;
}

/** «1–3, 5, 7–9» — номера пунктов подряд сворачиваются в диапазон */
export function ranges(items: number[]): string {
  const sorted = [...new Set(items)].sort((a, b) => a - b);
  const out: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  for (const n of sorted) {
    if (start === null) {
      start = n;
    } else if (prev !== null && n !== prev + 1) {
      out.push(start === prev ? `${start}` : prev === start + 1 ? `${start}, ${prev}` : `${start}–${prev}`);
      start = n;
    }
    prev = n;
  }
  if (start !== null && prev !== null) {
    out.push(start === prev ? `${start}` : prev === start + 1 ? `${start}, ${prev}` : `${start}–${prev}`);
  }
  return out.join(", ");
}

/** Ячейка таблицы markdown: без переводов строк и с экранированной чертой */
export function cell(text: string | null | undefined): string {
  return (text ?? "").replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim();
}

/** Таблица markdown из заголовков и строк */
export function table(head: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.map((c) => (c === "" ? " " : c)).join(" | ")} |`;
  return [line(head), `|${head.map(() => "---").join("|")}|`, ...rows.map(line)].join("\n");
}
