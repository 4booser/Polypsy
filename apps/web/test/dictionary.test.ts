import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ERRORS,
  LANGS,
  UI,
  makeUiT as sharedMakeUiT,
  renderError as sharedRenderError,
  type Lang,
  type UiKey,
} from "@quizzy/shared";
import { contentDefault, hasLanguage, loadLanguage, makeUiT, registerStrings, renderError, uiText } from "../src/dictionary";
import { CONTENT_DEFAULT_KEYS, buildLanguageTable } from "../src/dictionary/table";
import { LANG_KEY } from "../src/langKey";
import {
  coreKeys,
  fragmentKeys,
  fragmentModule,
  initialModules,
  keysIn,
  languageModule,
  preloadScript,
  sourceModule,
} from "../dictionaryPlugin";

/**
 * Словарь консоли — по языку и по экрану (волна 27, perf-bundle).
 *
 * Консоль больше не берёт трёхъязычный словарь из общего пакета: ядро
 * (строки того, что грузится сразу) едет куском на язык, а каждый экран
 * несёт свои строки фрагментом (apps/web/dictionaryPlugin.ts,
 * src/dictionary). Здесь сверяется, что от этого не изменилось ни одно
 * слово на экране: таблицы совпадают с makeUiT и renderError общего пакета,
 * а ядро и фрагменты вместе покрывают каждый ключ, к которому обращается
 * консоль.
 */

const WEB = resolve(import.meta.dir, "..");
const SRC = join(WEB, "src");
const SHARED = resolve(WEB, "../../packages/shared/src");
const DEFINITIONS = ["uiStrings.ts", "errorStrings.ts"].map((f) => join(SHARED, f));

const uiKeys = Object.keys(UI) as UiKey[];
const errorKeys = Object.keys(ERRORS);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("таблица языка совпадает со словарём общего пакета", () => {
  test("строки оболочки — те же, что у makeUiT: английский без перевода — украинский, пустой по замыслу — пустой", () => {
    for (const lang of LANGS) {
      const table = buildLanguageTable(UI, ERRORS, lang);
      const t = sharedMakeUiT(lang);
      const differ = uiKeys.filter((key) => table.ui[key] !== t(key));
      expect(differ, lang).toEqual([]);
      expect(Object.keys(table.ui)).toHaveLength(uiKeys.length);
    }
  });

  test("тексты отказов — те же, что у renderError", () => {
    for (const lang of LANGS) {
      const table = buildLanguageTable(UI, ERRORS, lang);
      expect(errorKeys.filter((key) => table.errors[key] !== sharedRenderError(key, lang))).toEqual([]);
    }
  });

  test("отбор оставляет только названные записи, а значения по умолчанию — всегда на обоих языках содержимого", () => {
    const only = { ui: new Set(["common.save"]), errors: new Set(["err.internal"]) };
    const table = buildLanguageTable(UI, ERRORS, "ru", only);
    expect(table.ui).toEqual({ "common.save": UI["common.save"].ru });
    expect(table.errors).toEqual({ "err.internal": ERRORS["err.internal"].ru });
    for (const key of CONTENT_DEFAULT_KEYS) expect(table.content[key]).toEqual({ uk: UI[key].uk, ru: UI[key].ru });
  });
});

describe("переводчик консоли — те же вызовы, то же поведение", () => {
  test("makeUiT и uiText отвечают как в общем пакете на каждом языке", () => {
    for (const lang of LANGS) {
      const web = makeUiT(lang);
      const shared = sharedMakeUiT(lang);
      expect(uiKeys.filter((key) => web(key) !== shared(key)), lang).toEqual([]);
      expect(uiText("common.save", lang)).toBe(shared("common.save"));
    }
  });

  test("неизвестный ключ — запасное значение, без него — сам ключ", () => {
    const t = makeUiT("uk");
    expect(t("rstatus.nonexistent" as UiKey, "nonexistent")).toBe("nonexistent");
    expect(t("rstatus.nonexistent" as UiKey)).toBe("rstatus.nonexistent");
  });

  test("renderError: подстановки и общий текст на неизвестный ключ", () => {
    for (const lang of LANGS) {
      for (const key of errorKeys) expect(renderError(key, lang)).toBe(sharedRenderError(key, lang));
      expect(renderError("err.noSuchThing", lang)).toBe(sharedRenderError("err.noSuchThing", lang));
    }
    const withParam = errorKeys.find((key) => ERRORS[key as keyof typeof ERRORS].uk.includes("{"))!;
    const name = ERRORS[withParam as keyof typeof ERRORS].uk.match(/\{(\w+)\}/)![1]!;
    expect(renderError(withParam, "uk", { [name]: "Х" })).toBe(sharedRenderError(withParam, "uk", { [name]: "Х" }));
  });

  test("строки экрана из фрагмента сборки находятся на своём языке; ядро — первым", () => {
    registerStrings({ "test.fragmentOnly": ["у", "р", "e"], "common.save": ["не", "это", "no"] }, { "err.fragmentOnly": ["у!", "р!", "e!"] });
    expect(makeUiT("uk")("test.fragmentOnly" as UiKey)).toBe("у");
    expect(makeUiT("ru")("test.fragmentOnly" as UiKey)).toBe("р");
    expect(makeUiT("en")("test.fragmentOnly" as UiKey)).toBe("e");
    expect(renderError("err.fragmentOnly", "ru")).toBe("р!");
    // ядро языка в памяти — его строка, а не фрагмента
    expect(makeUiT("ru")("common.save")).toBe(UI["common.save"].ru);
  });

  test("значение по умолчанию для содержимого — на обоих языках и каждый раз новой записью", () => {
    const yes = contentDefault("bp.yes");
    expect(yes).toEqual({ uk: UI["bp.yes"].uk, ru: UI["bp.yes"].ru });
    yes.uk = "змінено";
    expect(contentDefault("bp.yes").uk).toBe(UI["bp.yes"].uk);
  });

  test("вне сборки словарь любого языка уже в памяти: переключение не ждёт", async () => {
    for (const lang of LANGS) expect(hasLanguage(lang)).toBe(true);
    await loadLanguage("en");
  });
});

/** Модуль куска языка («export default {…}») — его значение */
const evaluate = (code: string) => new Function(code.replace(/^export default /, "return "))();

describe("сборка: ядро и фрагменты", () => {
  const initial = initialModules();
  const core = coreKeys(initial);
  const rel = (f: string) => f.slice(SRC.length + 1);

  test("ядро — модули начального куска: вход, оболочка, словарь; экраны — нет", () => {
    const mods = [...initial].filter((f) => f.startsWith(SRC)).map(rel);
    for (const m of ["main.tsx", "App.tsx", "lang.tsx", "dictionary/index.ts", "pages/Login.tsx", "shell/AppBar.tsx", "shell/Rail.tsx"]) {
      expect(mods).toContain(m);
    }
    for (const m of ["pages/Dashboard.tsx", "pages/Alerts.tsx", "pages/Patients.tsx", "pages/constructor/index.tsx", "charts/clinical.tsx"]) {
      expect(mods).not.toContain(m);
    }
    // подменённый источник и сами словари — не обращения к ключам
    expect(mods).not.toContain("dictionary/source.ts");
    for (const f of DEFINITIONS) expect(initial.has(f)).toBe(false);
  });

  test("в ядре — строки первого экрана, и только они", () => {
    expect(core.ui.has("app.title")).toBe(true);
    expect(core.ui.has("net.loadFailed")).toBe(true);
    // запасной текст отказа нужен renderError всегда
    expect(core.errors.has("err.internal")).toBe(true);
    expect(core.ui.size).toBeLessThan(uiKeys.length / 5);
  });

  test("кусок языка — только ядро, одной колонкой", () => {
    const table = evaluate(languageModule("ru", core));
    expect(Object.keys(table.ui).sort()).toEqual([...core.ui].sort());
    expect(table.ui["app.title"]).toBe(UI["app.title"].ru);
    // без отбора (dev-сервер) — весь словарь языка
    const full = evaluate(languageModule("en"));
    expect(Object.keys(full.ui)).toHaveLength(uiKeys.length);
  });

  test("ядро и фрагменты вместе покрывают каждый ключ, к которому обращается консоль", () => {
    /*
     * Признаки — те же, что у проверки мёртвых ключей (uiStrings.test.ts), но
     * набранные здесь отдельно: ключ целиком в двойных кавычках или шаблон
     * `семейство.${…}`. Ключ, видный ими в исходнике консоли или общего
     * пакета, но не попавший ни в ядро, ни во фрагмент своего модуля, стал бы
     * пустым местом на экране собранной консоли.
     */
    const files = [...sources(SRC), ...sources(SHARED)].filter((f) => !DEFINITIONS.includes(f) && !f.endsWith("dictionary/source.ts"));
    const covered = new Set([...core.ui, ...core.errors]);
    for (const file of files) {
      if (initial.has(file)) continue;
      const keys = fragmentKeys(readFileSync(file, "utf8"), core);
      for (const k of [...(keys?.ui ?? []), ...(keys?.errors ?? [])]) covered.add(k);
    }
    const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
    const quoted = new Set([...text.matchAll(/"([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]!));
    const families = [...new Set([...text.matchAll(/`([a-z][A-Za-z0-9.]*)\.\$\{/g)].map((m) => m[1]!))];
    const referenced = [...uiKeys, ...errorKeys].filter((key) => quoted.has(key) || families.some((p) => key.startsWith(`${p}.`)));
    expect(referenced.length).toBeGreaterThan(5000);
    expect(referenced.filter((key) => !covered.has(key))).toEqual([]);
  }, 30_000);

  test("признаки ключа: кавычки любые, семейство по шаблону и склейке; «toString» — не ключ", () => {
    const { ui, errors } = keysIn(
      'ut("common.save"); ut(\'common.close\'); x = `rstatus.${s}`; y = "dest." + d; z = "toString"; renderError("err.internal")',
    );
    expect(ui.has("common.save")).toBe(true);
    expect(ui.has("common.close")).toBe(true);
    expect([...ui].some((k) => k.startsWith("rstatus."))).toBe(true);
    expect([...ui].some((k) => k.startsWith("dest."))).toBe(true);
    expect(ui.has("toString")).toBe(false);
    expect(errors.has("err.internal")).toBe(true);
  });

  test("фрагмент — строки модуля на всех языках в порядке LANGS; строк ядра в нём нет", () => {
    const keys = fragmentKeys('ut("common.close"); ut("app.title")', { ui: new Set(["app.title"]), errors: new Set() })!;
    expect([...keys.ui]).toEqual(["common.close"]);
    const code = fragmentModule(keys);
    expect(code).toContain("registerStrings(");
    const [ui] = JSON.parse(`[${code.slice(code.indexOf("registerStrings(") + "registerStrings(".length, code.lastIndexOf(")"))}]`);
    expect(ui["common.close"]).toEqual(LANGS.map((lang: Lang) => sharedMakeUiT(lang)("common.close")));
    expect(fragmentKeys('ut("app.title")', { ui: new Set(["app.title"]), errors: new Set() })).toBeNull();
  });

  test("источник словаря в сборке: без ожидания — ничего, с ожиданием — кусок языка", () => {
    const code = sourceModule();
    expect(code).toContain("export function tableNow() { return null; }");
    for (const lang of LANGS) expect(code).toContain(`import("virtual:quizzy-dictionary/${lang}")`);
  });
});

describe("подсказка предзагрузки в index.html", () => {
  const URLS = { uk: "/assets/strings-uk.js", ru: "/assets/strings-ru.js", en: "/assets/strings-en.js" };

  /** Скрипт в поддельном окне: какую ссылку он поставил в предзагрузку */
  function run(saved: string | null | Error, languages: string[]): string | undefined {
    const added: { rel: string; href: string }[] = [];
    const storage = {
      getItem: (key: string) => {
        if (saved instanceof Error) throw saved;
        return key === LANG_KEY ? saved : null;
      },
    };
    const document = {
      createElement: () => ({ rel: "", href: "", crossOrigin: null as string | null }),
      head: { appendChild: (el: { rel: string; href: string }) => added.push(el) },
    };
    new Function("localStorage", "navigator", "document", preloadScript(URLS))(storage, { languages, language: languages[0] }, document);
    expect(added.every((el) => el.rel === "modulepreload")).toBe(true);
    return added[0]?.href;
  }

  test("выбор — тем же правилом, что readSavedLang: сохранённый, иначе языки браузера, без хранилища — украинский", () => {
    expect(run("ru", ["en-US"])).toBe(URLS.ru);
    expect(run(null, ["en-US", "uk"])).toBe(URLS.en);
    expect(run(null, ["de-DE"])).toBe(URLS.en);
    expect(run(null, [])).toBe(URLS.uk);
    expect(run("xx", ["ru-RU"])).toBe(URLS.ru);
    expect(run(new Error("SecurityError"), ["ru-RU"])).toBe(URLS.uk);
  });
});
