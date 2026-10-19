import { ERRORS, UI, type Lang } from "@quizzy/shared";
import { buildLanguageTable, type LanguageTable } from "./table";

/**
 * Откуда консоль берёт словарь языка — вне Vite.
 *
 * Здесь таблица строится тут же из полных общих словарей и отдаётся сразу,
 * без ожидания: так её получают проверки (bun test) и всё, что запускает
 * исходники консоли мимо сборщика. Экраны в проверках рисуются синхронно
 * (renderToStaticMarkup), и словарь, который надо было бы сначала дождаться,
 * означал бы ожидание в каждой из полусотни проверок разметки.
 *
 * В сборке и на dev-сервере этот модуль подменяет плагин
 * (apps/web/dictionaryPlugin.ts): там у каждого языка свой кусок
 * (`strings-uk`, `strings-ru`, `strings-en`), tableNow отвечает null, а
 * tableLater — обещанием догрузки куска; трёхъязычный словарь в браузер не
 * едет. Обе стороны строят таблицу одной функцией (table.ts), а равенство
 * таблицы и makeUiT общего пакета сверяет test/dictionary.test.ts.
 *
 * Это единственный файл консоли, которому можно брать UI и ERRORS из общего
 * пакета значениями: сторож — test/bundle.test.ts.
 */

/** Словарь языка без ожидания — или null, если его надо догружать (так отвечает сборка) */
export function tableNow(lang: Lang): LanguageTable | null {
  return buildLanguageTable(UI, ERRORS, lang);
}

/** Словарь языка с догрузкой */
export function tableLater(lang: Lang): Promise<LanguageTable> {
  return Promise.resolve(buildLanguageTable(UI, ERRORS, lang));
}
