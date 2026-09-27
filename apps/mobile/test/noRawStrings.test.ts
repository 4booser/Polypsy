import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { UI } from "@quizzy/shared";
/*
 * Разбор исходника — общий с консолью: правило одно на оба приложения, и
 * две копии разъехались бы на первой же правке. Импорт через каталог
 * консоли так же, как apps/api/test/constructorRoundtrip.test.ts берёт
 * модель конструктора.
 */
import { type Exception, type LatinName, judge, rawStrings, sourceFiles } from "../../web/test/rawStrings";

/**
 * Сторож сырых строк мобилки: всё видимое — через словарь.
 *
 * Правило то же, что у консоли (apps/web/test/noRawStrings.test.ts), а
 * списки свои: имя или исключение, которое живо только в консоли, здесь
 * было бы мёртвым, и наоборот.
 *
 * Сторож нашёл здесь то, что прежний (регулярки в uiStrings.test.ts)
 * пропускал: « · пропуск» в отчёте о прохождениях — литерал после пустой
 * строки сбивал регулярке чётность кавычек, и слово стояло по-русски на
 * всех трёх языках; «OK» на кнопке окна после записи на приём; «А» на
 * кнопке размера шрифта — одна буква, короче порога {2,}.
 */

const MOBILE = resolve(import.meta.dir, "..");
const ROOT = resolve(MOBILE, "../..");
const rel = (file: string) => file.slice(ROOT.length + 1);

const EXCEPTIONS: Exception[] = [
  {
    file: "apps/mobile/src/lang.tsx",
    text: "useLang вне LangProvider",
    why: "ошибка кода, а не данных: хук вне провайдера падает на первой отрисовке, до любого действия и строки ошибки экрана",
  },
  {
    file: "apps/mobile/src/auth/AuthContext.tsx",
    text: "useAuth должен использоваться внутри AuthProvider",
    why: "то же, что useLang: падение на первой отрисовке, текст для разработчика",
  },
];

const NAMES: LatinName[] = [
  { word: "Quizzy", file: "apps/mobile/app/login.tsx", why: "название продукта на экране входа" },
  {
    word: "XXXX",
    file: "apps/mobile/app/register.tsx",
    why: "маска кода приглашения «XXXX-XXXX» в поле ввода — образец формы кода, а не слово",
  },
];

function scanMobile() {
  const files = [...sourceFiles(join(MOBILE, "app")), ...sourceFiles(join(MOBILE, "src"))];
  return { files, found: files.flatMap((f) => rawStrings(rel(f), readFileSync(f, "utf8"))) };
}

describe("мобилка: видимые строки идут через словарь", () => {
  test("кириллица и латиница на экране — только из словаря", () => {
    const { files, found } = scanMobile();
    expect(files.length).toBeGreaterThan(30);
    const { offenders } = judge(found, EXCEPTIONS, NAMES);
    expect(offenders, "строка на экране мимо ut(): вынеси её в packages/shared/src/uiStrings.ts").toEqual([]);
  });

  test("каждое исключение и каждое имя срабатывает", () => {
    const { found } = scanMobile();
    const { deadExceptions, deadNames } = judge(found, EXCEPTIONS, NAMES);
    expect(deadExceptions, "исключение ничего не разрешает — убери его").toEqual([]);
    expect(deadNames, "имя нигде не встречается — убери его").toEqual([]);
  });
});

/**
 * Манифест приложения: тексты, которые показывает сама система.
 *
 * Окно iOS «Разрешить Quizzy использовать Face ID?» рисует не приложение, и
 * ut() до него не дотягивается: текст под вопросом система берёт из
 * Info.plist. Там стояла одна русская фраза — и украинец с английским
 * телефоном, и англичанин видели «Замок на приложение: подтверждение
 * личности при входе». Теперь переводы лежат в `expo.locales` (Expo
 * раскладывает их по InfoPlist.strings каждого языка), а основной текст —
 * английский: основной язык проекта Xcode — английский, и на телефоне без
 * наших трёх языков система покажет его, как и detectLang для такого
 * телефона выбирает английский.
 *
 * Язык окна — язык телефона, а не выбранный в приложении: это устройство
 * iOS, обойти его нельзя. Поэтому в каждом языке слово то же, что на
 * экране профиля (mp.appLock), — где бы человек ни встретил замок, он
 * назван одинаково.
 */
describe("манифест: системные окна на трёх языках", () => {
  const app = JSON.parse(readFileSync(join(MOBILE, "app.json"), "utf8")) as {
    expo: {
      plugins: (string | [string, Record<string, unknown>])[];
      locales?: Record<string, { ios?: Record<string, string> }>;
      ios?: { infoPlist?: Record<string, unknown> };
    };
  };

  /* параметр плагина → ключ Info.plist, который он заполняет */
  const PLIST_OF: Record<string, string> = { faceIDPermission: "NSFaceIDUsageDescription" };

  const pluginTexts = app.expo.plugins
    .filter((p): p is [string, Record<string, unknown>] => Array.isArray(p))
    .flatMap(([, options]) => Object.entries(options).filter(([k]) => /Permission$|UsageDescription$/.test(k)));

  test("у каждого текста разрешения есть перевод на все три языка", () => {
    expect(pluginTexts.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [option] of pluginTexts) {
      const key = PLIST_OF[option];
      if (!key) {
        missing.push(`${option}: добавь его ключ Info.plist в PLIST_OF и переводы в expo.locales`);
        continue;
      }
      for (const lang of ["uk", "ru", "en"] as const) {
        if (!app.expo.locales?.[lang]?.ios?.[key]?.trim()) missing.push(`${lang}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("основной текст — английский, и он совпадает с английским переводом", () => {
    for (const [option, text] of pluginTexts) {
      const key = PLIST_OF[option]!;
      expect(text).toBe(app.expo.locales?.en?.ios?.[key]);
    }
  });

  test("каждый язык своими буквами и тем же словом, что в профиле", () => {
    const wrong: string[] = [];
    const lock = UI["mp.appLock"];
    const text = (lang: "uk" | "ru" | "en") => app.expo.locales?.[lang]?.ios?.NSFaceIDUsageDescription ?? "";
    if (/[ыэъё]/i.test(text("uk"))) wrong.push(`uk: русские буквы — «${text("uk")}»`);
    if (/[іїєґ]/i.test(text("ru"))) wrong.push(`ru: украинские буквы — «${text("ru")}»`);
    if (/[Ѐ-ӿ]/.test(text("en"))) wrong.push(`en: кириллица — «${text("en")}»`);
    for (const lang of ["uk", "ru", "en"] as const) {
      if (!text(lang).startsWith(lock[lang])) wrong.push(`${lang}: не начинается с «${lock[lang]}» (mp.appLock)`);
    }
    expect(wrong).toEqual([]);
  });

  test("вне переводов в манифесте нет кириллицы", () => {
    const { locales: _locales, ...rest } = app.expo;
    expect(/[Ѐ-ӿ]/.test(JSON.stringify(rest)), "текст на языке людей — в expo.locales, а не в самом манифесте").toBe(
      false,
    );
  });
});
