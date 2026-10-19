import { LANGS, type ContentLang, type ErrorParams, type Lang, type UiKey } from "@quizzy/shared";
import { tableLater, tableNow } from "./source";
import type { ContentDefaultKey, LanguageTable } from "./table";

/**
 * Словарь консоли — по языку и по экрану (волна 27, perf-bundle).
 *
 * Консоль везла общий словарь на трёх языках сразу — 1,38 МБ начального
 * куска, хотя первому экрану нужны шесть сотен строк на одном языке.
 * Теперь (подробно — apps/web/dictionaryPlugin.ts):
 *  - ядро — строки того, что грузится сразу (вход, оболочка, набор), на
 *    выбранном языке: грузится до первой отрисовки (main.tsx), другой язык —
 *    при переключении (lang.tsx);
 *  - каждый экран несёт свои строки сам, на всех языках: сборка дописывает
 *    ему фрагмент, и тот регистрируется здесь (registerStrings) раньше, чем
 *    экран что-либо нарисует.
 * Сервер и мобилка берут полный словарь из общего пакета, как и раньше.
 *
 * Вызовы те же, что у общего пакета: makeUiT, uiText, renderError — с теми
 * же подписями и тем же поведением (запасной украинский у английского,
 * запасное значение у неизвестного ключа, err.internal у неизвестного
 * отказа). Консоль берёт их отсюда, а не из "@quizzy/shared": импорт оттуда
 * вернул бы в сборку полный словарь (сторож — test/bundle.test.ts).
 */

const ready = new Map<Lang, LanguageTable>();
const pending = new Map<Lang, Promise<void>>();
/** Последний загруженный словарь: запас, если спросили язык, которого ещё нет в памяти */
let latest: LanguageTable | null = null;
/** Строки экранов из фрагментов сборки: ключ → тексты в порядке LANGS */
const screenUi: Record<string, readonly string[]> = Object.create(null);
const screenErrors: Record<string, readonly string[]> = Object.create(null);

/**
 * Строки модуля консоли на всех языках — их регистрирует фрагмент, который
 * сборка дописывает модулю вне ядра (dictionaryPlugin.ts). Тексты — в
 * порядке LANGS, запасной украинский у английского уже подставлен.
 */
export function registerStrings(
  ui: Readonly<Record<string, readonly string[]>>,
  errors: Readonly<Record<string, readonly string[]>>,
): void {
  Object.assign(screenUi, ui);
  Object.assign(screenErrors, errors);
}

function keep(lang: Lang, table: LanguageTable): LanguageTable {
  ready.set(lang, table);
  latest = table;
  return table;
}

/** Словарь из памяти; источник без сети (проверки) отвечает сразу, сборка — нет, и тогда null */
function tableOf(lang: Lang): LanguageTable | null {
  const table = ready.get(lang);
  if (table) return table;
  const now = tableNow(lang);
  return now ? keep(lang, now) : null;
}

/** Словарь языка уже в памяти: переключение на него не ждёт сети */
export function hasLanguage(lang: Lang): boolean {
  return tableOf(lang) !== null;
}

/**
 * Догрузить словарь языка. Повторный вызов не грузит заново: в памяти —
 * сразу, в пути — то же обещание. Отказ (нет сети, кусок прежней выкатки)
 * отдаётся вызывающему, а следующий вызов пробует ещё раз.
 */
export function loadLanguage(lang: Lang): Promise<void> {
  if (tableOf(lang)) return Promise.resolve();
  let loading = pending.get(lang);
  if (!loading) {
    loading = tableLater(lang).then(
      (table) => {
        pending.delete(lang);
        keep(lang, table);
      },
      (error: unknown) => {
        pending.delete(lang);
        throw error;
      },
    );
    pending.set(lang, loading);
  }
  return loading;
}

/**
 * Перевод по ключу для выбранного языка — как makeUiT общего пакета.
 *
 * Строка ищется в ядре языка, затем в строках экранов (registerStrings).
 * Ядра этого языка в памяти может не оказаться только в промежутке
 * переключения; тогда строка берётся из последнего загруженного, а не
 * показывается ключом — дыра посреди экрана хуже мгновения на прежнем языке.
 */
export function makeUiT(lang: Lang) {
  const column = LANGS.indexOf(lang);
  return (key: UiKey, fallback?: string): string => {
    const text = tableOf(lang)?.ui[key] ?? screenUi[key]?.[column] ?? latest?.ui[key];
    return text === undefined ? (fallback ?? key) : text;
  };
}

/** Перевод одного ключа вне React — для тех, кто держит язык в переменной (api.ts, useResource.ts) */
export function uiText(key: UiKey, lang: Lang): string {
  return makeUiT(lang)(key);
}

/**
 * Текст отказа сервера на нужном языке — как renderError общего пакета:
 * неизвестный ключ даёт общий текст «внутренняя ошибка», а не сам ключ.
 */
export function renderError(key: string, lang: Lang, params?: ErrorParams): string {
  const column = LANGS.indexOf(lang);
  const find = (k: string) => tableOf(lang)?.errors[k] ?? screenErrors[k]?.[column] ?? latest?.errors[k];
  let text = find(key) ?? find("err.internal") ?? key;
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/**
 * Значение по умолчанию для содержимого методики — на обоих языках
 * содержимого сразу, каким бы ни был язык интерфейса (CONTENT_DEFAULT_KEYS).
 * Каждый вызов — новая запись: черновик правит её на месте.
 */
export function contentDefault(key: ContentDefaultKey): Record<ContentLang, string> {
  const pair = (latest ?? tableOf("uk"))?.content[key];
  return pair ? { uk: pair.uk, ru: pair.ru } : { uk: key, ru: key };
}
