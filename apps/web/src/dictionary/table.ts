import type { ContentLang, Lang, UiKey } from "@quizzy/shared";

/**
 * Ядро словаря консоли на одном языке (волна 27, perf-bundle).
 *
 * Общий словарь (packages/shared/src/uiStrings.ts) держит каждую запись на
 * трёх языках сразу, и консоль везла его целиком: 1,38 МБ, хотя первому
 * экрану нужны шесть сотен строк на одном языке. Здесь — одна колонка:
 * ключ → готовая строка. В сборке таблица — ядро (строки того, что грузится
 * сразу), а строки экранов едут с экранами (dictionaryPlugin.ts); в проверках
 * (source.ts) — весь словарь языка. Строится одной функцией и там и там,
 * поэтому таблица и makeUiT общего пакета не могут разойтись молча, а сверяет
 * их test/dictionary.test.ts.
 */
export interface LanguageTable {
  /**
   * Строки оболочки. Запасной перевод уже подставлен: у записи без
   * английского стоит украинский — то же правило, что в makeUiT. Пустая
   * строка остаётся пустой (EMPTY_BY_DESIGN_EN: «1986р.» по-английски без
   * суффикса).
   */
  ui: Readonly<Record<string, string>>;
  /** Тексты отказов сервера на этом языке — для renderError консоли */
  errors: Readonly<Record<string, string>>;
  /** Тексты по умолчанию для содержимого методики — на обоих языках содержимого (CONTENT_DEFAULT_KEYS) */
  content: Readonly<Record<string, Readonly<Record<ContentLang, string>>>>;
}

/**
 * Записи словаря, которые нужны на ОБОИХ языках содержимого сразу.
 *
 * Это не подписи интерфейса, а начальное содержимое методики: новый вопрос
 * приходит с ответами «Так / Ні» сразу по-украински и по-русски, итоговая
 * шкала комплексного теста — с названием «Результати / Результаты»
 * (pages/constructor). Язык интерфейса здесь ни при чём, а в памяти лежит
 * только он один — поэтому эти записи едут в куске каждого языка обеими
 * колонками. Список короткий намеренно: запись сюда — по одной на значение
 * по умолчанию, а не «на всякий случай». Ключ, которого нет в словаре, не
 * соберётся (`satisfies`).
 */
export const CONTENT_DEFAULT_KEYS = ["bp.yes", "bp.no", "cn.results"] as const satisfies readonly UiKey[];
export type ContentDefaultKey = (typeof CONTENT_DEFAULT_KEYS)[number];

export type Entry = { uk: string; ru: string; en?: string };

/** Какие записи брать: без отбора — все (проверки, dev-сервер), с отбором — ядро сборки (dictionaryPlugin.ts) */
export interface KeySelection {
  ui: ReadonlySet<string>;
  errors: ReadonlySet<string>;
}

/** Текст записи на языке; английский без перевода — украинский, пустой по замыслу — пустой (как в makeUiT) */
export function entryText(entry: Entry, lang: Lang): string {
  return entry[lang] ?? entry.uk;
}

export function buildLanguageTable(
  ui: Readonly<Record<string, Entry>>,
  errors: Readonly<Record<string, Entry>>,
  lang: Lang,
  only?: KeySelection,
): LanguageTable {
  const column = (dict: Readonly<Record<string, Entry>>, keep?: ReadonlySet<string>) => {
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(dict)) if (!keep || keep.has(key)) out[key] = entryText(entry, lang);
    return out;
  };
  const content: Record<string, Record<ContentLang, string>> = {};
  for (const key of CONTENT_DEFAULT_KEYS) {
    const entry = ui[key];
    if (entry) content[key] = { uk: entry.uk, ru: entry.ru };
  }
  return { ui: column(ui, only?.ui), errors: column(errors, only?.errors), content };
}
