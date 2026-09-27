import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FEATURE_FLAGS, PERMISSION_EFFECTS, PERMISSION_GROUPS, PERMISSION_TITLES } from "@quizzy/shared";
import { type Exception, type LatinName, judge, rawStrings, sourceFiles } from "./rawStrings";

/**
 * Сторож сырых строк консоли: всё видимое — через словарь.
 *
 * Внешнее ревью насчитало «сотни строк вне словаря». В исходниках консоли
 * сырого литерала на экране не нашлось ни одного — прежний сторож
 * (регулярки в uiStrings.test.ts) это держал; в мобилке нашлось три, и все
 * три регулярки пропускали по устройству (см. rawStrings.ts). Сотни жили
 * там, куда сторож не смотрел: витрина UiKit (сознательное исключение,
 * ниже), справочник прав без английского (packages/shared/src/permissions.ts
 * — чинится вместе с этим сторожем; на английском экране прав стояли пустые
 * строки) и тексты, которые собирает сервер. Здесь правило держится разбором
 * исходника компилятором.
 *
 * Мобилка сторожится своим файлом (apps/mobile/test/noRawStrings.test.ts)
 * по тому же правилу: у неё свои имена и свои исключения, и мёртвое
 * исключение одного приложения не должно прятаться за живым в другом.
 */

const WEB = resolve(import.meta.dir, "..");
const ROOT = resolve(WEB, "../..");
const rel = (file: string) => file.slice(ROOT.length + 1);

/*
 * Файлы, которые не проверяются вовсе. Список короткий намеренно: длинный
 * список исключений означает, что правило не работает.
 */
const SKIPPED_FILES = new Map<string, string>([
  [
    "apps/web/src/pages/UiKit.tsx",
    "витрина языка интерфейса по адресу /ui: демонстрационные данные и пояснения к самой " +
      "системе оформления, в меню её нет. Читает её разработчик, а не специалист в кабинете; " +
      "переводить «Петров Дмитрий» и «Рота обеспечения» не для кого",
  ],
]);

/*
 * Сообщения разработчику, которые до экрана не доходят, — поимённо.
 *
 * Поимённо, а не правилом «throw new Error свободен»: консоль показывает
 * текст любой брошенной в действии ошибки тостом (useAction), и новое
 * сообщение, брошенное внутри действия, человек прочтёт. У каждого места
 * ниже названо, почему это не тот случай.
 */
const EXCEPTIONS: Exception[] = [
  {
    file: "apps/web/src/auth.tsx",
    text: "useAuth вне AuthProvider",
    why: "ошибка кода, а не данных: хук вне провайдера падает на первой же отрисовке, до любого действия. Текст совпадает с исходником, чтобы его находили поиском",
  },
  {
    file: "apps/web/src/lang.tsx",
    text: "useLang вне LangProvider",
    why: "то же, что useAuth: падение на первой отрисовке, до действия и тоста",
  },
  {
    file: "apps/web/src/ui/primitives.tsx",
    text: "<${…}> в кабинете пациента без подписи",
    why: "проверка доступности только в разработке (import.meta.env.PROD !== true): поле без подписи в кабинете пациента роняет отрисовку у разработчика, в боевой сборке проверки нет",
  },
  {
    file: "apps/web/src/shell/Rail.tsx",
    text: "рельса: ключ группы «${…}» повторяется",
    why: "сторож сборки меню: две группы с одним ключом — ошибка кода, бросается при отрисовке рельсы, до действия и тоста",
  },
  {
    file: "apps/web/src/events.ts",
    text: "events ${…}",
    why: "отказ канала событий бросается внутри цикла переподключения и там же глушится (catch → пауза и повтор); на экран не выходит",
  },
];

/*
 * Латинские слова, одинаковые на любом языке: их «перевод» — они сами.
 *
 * Имена, а не слова: название продукта, международное статистическое
 * сокращение, запись значения в языке запросов. Всё, что можно сказать
 * по-украински, сюда не попадает — для этого есть словарь. Имя с файлом
 * разрешено только в нём.
 */
const NAMES: LatinName[] = [
  { word: "Quizzy", why: "название продукта" },
  { word: "PSI", why: "Population Stability Index — сокращение международное, в украинских и русских работах пишется латиницей" },
  { word: "ICC", why: "Intraclass Correlation — то же" },
  { word: "RCI", why: "Reliable Change Index (Jacobson–Truax) — то же" },
  {
    word: "NULL",
    file: "apps/web/src/pages/ops/sec/Sql.tsx",
    why: "SQL-консоль суперадмина: пустое значение ячейки показано так, как его пишет сам SQL, — «порожньо» спутать с пустой строкой",
  },
];

function scanWeb() {
  const files = sourceFiles(join(WEB, "src")).filter((f) => !SKIPPED_FILES.has(rel(f)));
  return { files, found: files.flatMap((f) => rawStrings(rel(f), readFileSync(f, "utf8"))) };
}

describe("консоль: видимые строки идут через словарь", () => {
  test("кириллица и латиница на экране — только из словаря", () => {
    const { files, found } = scanWeb();
    /*
     * Сначала — что файлы вообще нашлись. Без этой строки проверка при
     * неверном пути обходила бы пустой список и объявляла победу.
     */
    expect(files.length).toBeGreaterThan(100);
    const { offenders } = judge(found, EXCEPTIONS, NAMES);
    expect(offenders, "строка на экране мимо ut(): вынеси её в packages/shared/src/uiStrings.ts").toEqual([]);
  });

  test("каждое исключение и каждое имя срабатывает", () => {
    const { found } = scanWeb();
    const { deadExceptions, deadNames } = judge(found, EXCEPTIONS, NAMES);
    expect(deadExceptions, "исключение ничего не разрешает — убери его").toEqual([]);
    expect(deadNames, "имя нигде не встречается — убери его").toEqual([]);
  });

  test("пропущенные файлы существуют", () => {
    for (const file of SKIPPED_FILES.keys()) {
      expect(() => readFileSync(join(ROOT, file)), `${file} пропал — убери его из списка`).not.toThrow();
    }
  });
});

/*
 * Сторож проверяется на том, что пропускал прежний.
 *
 * Зелёная проверка доказывает только то, что нарушений она не нашла. Что
 * она вообще умеет их находить, доказывают вот эти образцы: каждый — случай,
 * который жил в коде или мог жить, и который регулярки не видели.
 */
describe("сторож ловит то, что пропускали регулярки", () => {
  const scan = (src: string) => rawStrings("x.tsx", src).map((f) => `${f.kind}: ${f.text}`);

  test("пустая строка перед литералом не сбивает чётность кавычек", () => {
    expect(scan(`const A = () => <Text>{a ? "" : " · пропуск"}</Text>;`)).toEqual(["cyrillic: · пропуск"]);
  });

  test("одна буква — тоже текст", () => {
    expect(scan(`const A = () => <Text>А{big ? "+" : ""}</Text>;`)).toEqual(["cyrillic: А"]);
  });

  test("многострочный шаблон и склейка — одна фраза", () => {
    expect(scan("const s = `Методика\n${i} з ${n}`;")).toEqual(["cyrillic: Методика ${…} з ${…}"]);
    expect(scan(`const s = "Перша частина, " + \`друга \${x}\`;`)).toEqual(["cyrillic: Перша частина, друга ${…}"]);
  });

  test("комментарии и консоль разработчика — не текст интерфейса", () => {
    expect(scan(`// «Українською»\n/* пояснення */\nconsole.warn("запис не вдався", x);`)).toEqual([]);
  });

  test("брошенная ошибка не освобождена: её текст уходит в тост", () => {
    expect(scan(`run(async () => { throw new Error("Не вдалося зберегти"); });`)).toEqual([
      "cyrillic: Не вдалося зберегти",
    ]);
    expect(scan(`run(async () => { throw new Error("Upload failed"); });`)).toEqual(["latin: Upload failed"]);
  });

  test("латиница в тексте, подписи, окне и тосте", () => {
    expect(scan(`const A = () => <p>Loading</p>;`)).toEqual(["latin: Loading"]);
    expect(scan(`const A = () => <input placeholder="Search" />;`)).toEqual(["latin: Search"]);
    expect(scan(`const A = () => <input aria-label={busy ? "Saving" : ut("x.y")} />;`)).toEqual(["latin: Saving"]);
    expect(scan(`window.confirm("Delete?");`)).toEqual(["latin: Delete?"]);
    expect(scan(`toast("Saved", "ok");`)).toEqual(["latin: Saved"]);
    expect(scan(`Alert.alert(ut("a"), "", [{ text: "OK", onPress }]);`)).toEqual(["latin: OK"]);
  });

  test("код, ключи и значения протокола — не текст", () => {
    expect(scan(`const A = () => <kbd>esc</kbd>;`)).toEqual([]);
    expect(scan(`const A = () => <pre>{"postgres: -c shared_preload_libraries"}</pre>;`)).toEqual([]);
    expect(scan(`const A = () => <Hint text="hint.rci" />;`)).toEqual([]);
    expect(scan(`const A = () => <p title={ut("a.b")}>{ut("a.c")}</p>;`)).toEqual([]);
    expect(scan(`const A = () => <p className="text-muted">{kind === "done" ? ut("a") : ut("b")}</p>;`)).toEqual([]);
    expect(scan(`toast(ut("x"), "ok");`)).toEqual([]);
  });
});

/*
 * Справочники, которые живут не в словаре, но показываются на экране.
 *
 * Права и флаги функций отдаёт сервер одной записью на три языка (см.
 * CatalogText в permissions.ts), и сторож литералов их не видит: для него
 * это законные строки в packages/shared. Здесь — то, что у словаря проверяют
 * langLetters.test.ts и uiStrings.test.ts: все три языка на месте, и каждый
 * своими буквами. Справочник прав до этой проверки был без английского
 * целиком, и на английском экране прав стояли пустые строки.
 */
describe("справочники вне словаря — на трёх языках", () => {
  const entries: [string, { uk: string; ru: string; en: string }][] = [
    ...PERMISSION_GROUPS.map((g) => [`group ${g.code}`, g.title] as [string, { uk: string; ru: string; en: string }]),
    ...Object.entries(PERMISSION_TITLES).map(([k, v]) => [`title ${k}`, v] as [string, typeof v]),
    ...Object.entries(PERMISSION_EFFECTS).map(([k, v]) => [`opens ${k}`, v.opens] as [string, typeof v.opens]),
    ...Object.entries(FEATURE_FLAGS).flatMap(([k, v]) => [
      [`flag ${k}`, v.title] as [string, typeof v.title],
      [`flag ${k} description`, v.description] as [string, typeof v.description],
    ]),
  ];

  test("ни одного пустого перевода", () => {
    expect(entries.length).toBeGreaterThan(70);
    const empty = entries.filter(([, v]) => !v.uk?.trim() || !v.ru?.trim() || !v.en?.trim()).map(([k]) => k);
    expect(empty).toEqual([]);
  });

  test("каждый язык своими буквами", () => {
    const wrong: string[] = [];
    for (const [k, v] of entries) {
      if (/[ыэъё]/i.test(v.uk)) wrong.push(`${k}: русские буквы в uk — «${v.uk}»`);
      if (/[іїєґ]/i.test(v.ru)) wrong.push(`${k}: украинские буквы в ru — «${v.ru}»`);
      if (/[Ѐ-ӿ]/.test(v.en)) wrong.push(`${k}: кириллица в en — «${v.en}»`);
    }
    expect(wrong).toEqual([]);
  });
});
