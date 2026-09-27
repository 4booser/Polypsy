import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Exception, judge, rawStrings, sourceFiles } from "../../web/test/rawStrings";

/**
 * Сторож сырых строк сервера: текст, который собирает сервер или общий
 * пакет, — через словарь.
 *
 * Серверный близнец apps/web/test/noRawStrings.test.ts, и заведён по его же
 * находке. Интерфейс веба оказался чист, а «сотни строк вне словаря» жили
 * там, где текст складывает сервер: проблемы методики, сравнение версий,
 * предупреждения подсчёта и объяснения правил, печатные листы, подписи
 * SPSS, вывод командной консоли, сообщения схем. Всё это было по-русски на
 * любом языке интерфейса (волна 13, srv-i18n) и теперь идёт через
 * packages/shared/src/serverStrings.ts и ERRORS.
 *
 * Правило строже, чем у клиента, и проще: в охраняемом модуле кириллица
 * допустима только в комментарии и в выводе console.* — любой другой
 * кириллический литерал есть фраза, которую прочтёт человек, или ошибка.
 * Разбор — тем же компилятором (rawStrings.ts): регулярка здесь промахнулась
 * бы на шаблонах разметки печатных листов, где русские слова стояли прямо
 * в тексте HTML.
 *
 * Что не охраняется, и почему — тексты методик (instruments/, это контент
 * каталога), демоданные (seed, demo*), документация OpenAPI (openapi.ts, её
 * читает разработчик), командные скрипты эксплуатации (install.ts и
 * соседи — терминал того, кто выкатывает). Остальные маршруты сервера ещё
 * собирают несколько фраз по-русски (названия копий и версий методик,
 * подписи норм); они перечислены в отчёте участка и сюда встанут, когда их
 * переведут.
 */

const ROOT = resolve(import.meta.dir, "../../..");
const rel = (file: string) => file.slice(ROOT.length + 1);

/*
 * Модули сервера под охраной — поимённо: каждый из них собирал фразы
 * по-русски, и каждый переведён целиком.
 */
const SERVER_MODULES = [
  "apps/api/src/routes/reports.ts",
  "apps/api/src/routes/spss.ts",
  "apps/api/src/routes/console.ts",
  "apps/api/src/routes/decisions.ts",
  "apps/api/src/lib/commands.ts",
  "apps/api/src/lib/decisions.ts",
  "apps/api/src/lib/http.ts",
];

/*
 * Общий пакет — целиком. Он работает и на сервере, и в клиентах, и фраза,
 * набранная в нём, приезжает готовой туда, где её уже не перевести.
 * Словари и справочники на трёх языках — сами по себе место для кириллицы;
 * их полноту и буквы проверяют свои тесты.
 */
const SHARED_DIR = "packages/shared/src";
const SHARED_SKIPPED = new Map<string, string>([
  ["packages/shared/src/uiStrings.ts", "словарь оболочки — uiStrings.test.ts, langLetters.test.ts"],
  ["packages/shared/src/errorStrings.ts", "словарь отказов — apps/api/test/errorStrings.test.ts"],
  ["packages/shared/src/pushStrings.ts", "словарь уведомлений — uiStrings.test.ts, «английский в словарях сервера»"],
  ["packages/shared/src/serverStrings.ts", "словарь сервера — packages/shared/test/serverStrings.test.ts"],
  ["packages/shared/src/permissions.ts", "справочник прав на трёх языках — apps/web/test/noRawStrings.test.ts"],
  ["packages/shared/src/featureFlags.ts", "справочник флагов на трёх языках — apps/web/test/noRawStrings.test.ts"],
]);

/*
 * Исключения — поимённо и с причиной, как у клиента. Каждое обязано
 * срабатывать: мёртвое исключение молча разрешило бы новую фразу, которая
 * начнётся теми же словами.
 */
const EXCEPTIONS: Exception[] = [
  {
    file: "packages/shared/src/types.ts",
    text: "Українська",
    why: "название языка на самом себе (LANG_NAMES): по нему человек находит свой язык в переключателе — переводу не подлежит",
  },
  { file: "packages/shared/src/types.ts", text: "УКР", why: "то же, короткая подпись переключателя" },
  { file: "packages/shared/src/types.ts", text: "Русский", why: "то же, LANG_NAMES" },
  { file: "packages/shared/src/types.ts", text: "РУС", why: "то же, короткая подпись переключателя" },
  {
    file: "packages/shared/src/types.ts",
    text: "Мова / Язык / Language",
    why: "имя переключателя языка на всех языках сразу (LANG_SELF_LABEL): его ищут по слову, которое читают",
  },
  {
    file: "packages/shared/src/format.ts",
    text: "с",
    why: "таблица единиц длительности по языкам (DURATION_UNITS): это и есть перевод, по записи на язык",
  },
  { file: "packages/shared/src/format.ts", text: "хв", why: "то же: украинская минута" },
  { file: "packages/shared/src/format.ts", text: "мин", why: "то же: русская минута" },
  {
    file: "packages/shared/src/dates.ts",
    text: "ожидается существующая дата ГГГГ-ММ-ДД",
    why: "сообщение разработчику в проблеме zod; человеку уходит перевод по params.errorKey (err.invalidDateParam, lib/http.ts)",
  },
  {
    file: "packages/shared/src/wireSchemas.ts",
    text: "ожидается существующий момент ISO 8601",
    why: "то же: сообщение разработчику, человеку — err.invalidDateParam по params.errorKey",
  },
];

function scan() {
  const shared = sourceFiles(join(ROOT, SHARED_DIR)).filter(
    (f) => !/\.test\.tsx?$/.test(f) && !SHARED_SKIPPED.has(rel(f)),
  );
  const files = [...SERVER_MODULES.map((f) => join(ROOT, f)), ...shared];
  const found = files
    .flatMap((f) => rawStrings(rel(f), readFileSync(f, "utf8")))
    // латиница на сервере — это код, протокол и имена переменных выгрузки; фразы ищем по кириллице
    .filter((x) => x.kind === "cyrillic");
  return { files, found };
}

describe("сервер и общий пакет: фразы — через словарь", () => {
  test("кириллица в охраняемых модулях — только в комментариях и в исключениях", () => {
    const { files, found } = scan();
    // сначала — что файлы нашлись: иначе проверка обошла бы пустой список и объявила победу
    expect(files.length).toBeGreaterThan(SERVER_MODULES.length + 20);
    const { offenders } = judge(found, EXCEPTIONS, []);
    expect(
      offenders,
      "фраза мимо словаря: вынеси её в packages/shared/src/serverStrings.ts (или ERRORS) и собирай на языке запроса",
    ).toEqual([]);
  });

  test("каждое исключение срабатывает", () => {
    const { found } = scan();
    const { deadExceptions } = judge(found, EXCEPTIONS, []);
    expect(deadExceptions, "исключение ничего не разрешает — убери его").toEqual([]);
  });

  test("охраняемые и пропущенные файлы существуют", () => {
    for (const file of [...SERVER_MODULES, ...SHARED_SKIPPED.keys()]) {
      expect(() => readFileSync(join(ROOT, file)), `${file} пропал — поправь список`).not.toThrow();
    }
  });
});

/*
 * Сторож проверяется на том, что пропускал бы глаз: русские слова внутри
 * шаблона разметки печатного листа и внутри CSS-комментария, который
 * уезжает вместе со страницей.
 */
describe("сторож сервера ловит то, ради чего заведён", () => {
  const scanOne = (src: string) => rawStrings("x.ts", src).filter((f) => f.kind === "cyrillic").map((f) => f.text);

  test("фраза в шаблоне разметки — нарушение", () => {
    expect(scanOne("const html = `<h2>Ответы</h2><td>${n} из ${m}</td>`;")).toEqual([
      "<h2>Ответы</h2><td>${…} из ${…}</td>",
    ]);
  });

  test("CSS-комментарий внутри шаблона — тоже текст страницы", () => {
    expect(scanOne("const css = `/* таблицы не рвутся */ tr { break-inside: avoid; }`;")).toHaveLength(1);
  });

  test("комментарий кода и вывод console.* — не фраза для человека", () => {
    expect(scanOne(`// «пояснение»\n/* довод */\nconsole.log("Готово: шагов", n);`)).toEqual([]);
  });

  test("ключ словаря вместо фразы проходит", () => {
    expect(scanOne(`throw new CommandError("cmd.notFound", { email });`)).toEqual([]);
  });
});
