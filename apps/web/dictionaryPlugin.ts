import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePath, type Plugin } from "vite";
import { ERRORS } from "../../packages/shared/src/errorStrings";
import { LANGS, isLang, type Lang } from "../../packages/shared/src/types";
import { UI, detectLang } from "../../packages/shared/src/uiStrings";
import { buildLanguageTable, entryText, type Entry, type KeySelection } from "./src/dictionary/table";
import { LANG_KEY } from "./src/langKey";

/**
 * Словарь консоли — по языку и по экрану (волна 27, perf-bundle).
 *
 * Консоль брала общий словарь целиком: 8,9 тысячи записей, каждая на трёх
 * языках, — 1,38 МБ начального куска (684 КБ на main), хотя первому экрану
 * нужны шесть сотен строк на одном языке. Теперь:
 *
 *  - ЯДРО — строки модулей, которые грузятся сразу (статический граф от
 *    main.tsx: вход, оболочка, набор), — на ОДНОМ языке: свой кусок на язык
 *    (`strings-uk`, `strings-ru`, `strings-en`). Консоль грузит кусок своего
 *    языка до первой отрисовки, другой — при переключении (src/dictionary,
 *    src/lang.tsx). В index.html сборка вписывает маленький скрипт, который
 *    ставит кусок выбранного языка в предзагрузку, — он едет вместе с кодом
 *    консоли, а не после него.
 *  - ЭКРАНЫ — каждый модуль вне ядра несёт свои строки сам: сборка дописывает
 *    ему импорт крошечного модуля-фрагмента со строками этого модуля на всех
 *    трёх языках. Фрагмент едет в том же куске, что и экран, и регистрируется
 *    раньше, чем экран что-либо нарисует, — ни ожидания, ни мигания ключей;
 *    переключение языка на уже открытом экране ничего не догружает.
 *
 * Какие строки нужны модулю — по тем же признакам, по которым проверка
 * мёртвых ключей (test/uiStrings.test.ts) считает ключ званым: ключ целиком в
 * кавычках или шаблон `семейство.${…}` (тогда — всё семейство). Другого пути
 * к словарю у консоли нет: строка, которую не видно этими признаками, была бы
 * мёртвым ключом для той проверки. Полноту сверяет test/dictionary.test.ts.
 *
 * Сервер и мобилка этого не касается: они берут полный словарь из общего
 * пакета, как и раньше. На dev-сервере ядро — весь словарь языка, без
 * фрагментов: разбиение по экранам нужно только сборке, а его правильность
 * проверяют e2e против собранной консоли.
 *
 * Словарь читается при загрузке настроек Vite (импорт выше), и dev-сервер
 * перезапускается сам, когда uiStrings.ts меняется, — так Vite поступает с
 * любым файлом, от которого зависят настройки.
 */

const WEB = normalizePath(realpathSync(dirname(fileURLToPath(import.meta.url))));
const SRC = `${WEB}/src`;
const SHARED = normalizePath(realpathSync(resolve(WEB, "../../packages/shared/src")));
/** src/dictionary/source.ts: в сборке подменяется (см. sourceModule) */
const SOURCE = `${SRC}/dictionary/source.ts`;
const DICTIONARY = `${SRC}/dictionary/index.ts`;
/** Сами словари: ключи в них — объявления, а не обращения */
const DEFINITIONS = new Set([`${SHARED}/uiStrings.ts`, `${SHARED}/errorStrings.ts`]);

const SOURCE_ID = "\0quizzy-dictionary-source";
const TABLE = "virtual:quizzy-dictionary/";
const TABLE_ID = `\0${TABLE}`;
const FRAGMENT = "virtual:quizzy-strings/";
const FRAGMENT_ID = `\0${FRAGMENT}`;

const UI_ENTRIES: Readonly<Record<string, Entry>> = UI;
const ERROR_ENTRIES: Readonly<Record<string, Entry>> = ERRORS;
const UI_KEYS = Object.keys(UI_ENTRIES);
const ERROR_KEYS = Object.keys(ERROR_ENTRIES);
/* множества, а не `in`: «toString» и «constructor» — не ключи словаря, хоть и есть у любого объекта */
const UI_SET = new Set(UI_KEYS);
const ERROR_SET = new Set(ERROR_KEYS);

export interface Keys {
  ui: Set<string>;
  errors: Set<string>;
}

/**
 * Ключи словарей, к которым обращается исходник: ключ целиком в кавычках
 * (любых — и в данных, и в разметке, и в вызове ut) и семейство по шаблону
 * `семейство.${…}` или склейке "семейство." + … Лишний ключ здесь стоит
 * несколько байт, пропущенный — строку на экране, поэтому признаки широкие:
 * комментарии не вырезаются, а семейство берётся по любому началу с точкой.
 */
export function keysIn(code: string): Keys {
  const ui = new Set<string>();
  const errors = new Set<string>();
  for (const m of code.matchAll(/["'`]([A-Za-z][\w.-]*)["'`]/g)) {
    const key = m[1]!;
    if (UI_SET.has(key)) ui.add(key);
    else if (ERROR_SET.has(key)) errors.add(key);
  }
  const families = new Set<string>();
  for (const m of code.matchAll(/`([A-Za-z][\w-]*\.[\w.-]*)\$\{/g)) families.add(m[1]!);
  for (const m of code.matchAll(/["'`]([A-Za-z][\w-]*\.[\w.-]*)["'`]\s*\+/g)) families.add(m[1]!);
  for (const family of families) {
    for (const key of UI_KEYS) if (key.startsWith(family)) ui.add(key);
    for (const key of ERROR_KEYS) if (key.startsWith(family)) errors.add(key);
  }
  return { ui, errors };
}

/* ─────────── ядро: модули, которые грузятся сразу ─────────── */

/** Статические импорты значений: `import type` и `import()` в граф не входят (как в test/bundle.test.ts) */
function staticImports(text: string): { spec: string; names: string[] }[] {
  const out: { spec: string; names: string[] }[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?([^"';]*?)\s*from\s*["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  for (const m of text.matchAll(re)) {
    if (m[5]) {
      out.push({ spec: m[5], names: [] });
      continue;
    }
    if (m[2]) continue;
    const clause = m[3] ?? "";
    const names = [...clause.matchAll(/\{([^}]*)\}/g)]
      .flatMap((b) => b[1]!.split(","))
      .map((n) => n.trim())
      .filter((n) => n && !n.startsWith("type "))
      .map((n) => n.split(/\s+as\s+/)[0]!.trim());
    out.push({ spec: m[4]!, names: clause.includes("{") ? names : ["*"] });
  }
  return out;
}

function resolveFile(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const p of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(p) && statSync(p).isFile()) return normalizePath(p);
  }
  return null;
}

/** Где в общем пакете объявлено имя: модуль консоли берёт его из "@quizzy/shared" одной точкой входа */
function sharedDeclarations(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(SHARED)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const file = `${SHARED}/${f}`;
    for (const m of readFileSync(file, "utf8").matchAll(/export\s+(?:const|function|class|let|enum)\s+(\w+)/g)) out.set(m[1]!, file);
  }
  return out;
}

/**
 * Модули начального куска: всё, что достижимо от main.tsx статическими
 * импортами, и модули общего пакета, из которых эти модули берут значения.
 *
 * Ошибка этой оценки не ломает экран, а лишь меняет вес: модуль, который она
 * пропустила, получит свой фрагмент и привезёт его в начальном куске на трёх
 * языках; модуль, который она взяла лишним, отдаст свои строки ядру.
 */
export function initialModules(): Set<string> {
  const declared = sharedDeclarations();
  const seen = new Set<string>();
  const queue = [`${SRC}/main.tsx`];
  while (queue.length) {
    const file = queue.pop()!;
    // источник словаря в сборке подменён, а сами словари — объявления, а не обращения
    if (seen.has(file) || file === SOURCE || DEFINITIONS.has(file)) continue;
    seen.add(file);
    for (const { spec, names } of staticImports(readFileSync(file, "utf8"))) {
      if (spec.endsWith(".css")) continue;
      if (spec === "@quizzy/shared") {
        for (const name of names) {
          const at = declared.get(name);
          if (at) queue.push(at);
        }
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const next = resolveFile(file, spec);
      if (next) queue.push(next);
    }
  }
  return seen;
}

/** Ключи, к которым обращаются модули ядра */
export function coreKeys(modules: ReadonlySet<string>): Keys {
  const out: Keys = { ui: new Set(), errors: new Set() };
  for (const file of modules) {
    const { ui, errors } = keysIn(readFileSync(file, "utf8"));
    for (const k of ui) out.ui.add(k);
    for (const k of errors) out.errors.add(k);
  }
  return out;
}

/* ─────────── модули, которые пишет сборка ─────────── */

/** Имя куска со словарём языка — для manualChunks (vite.config.ts) */
export function languageChunk(id: string): string | undefined {
  return id.startsWith(TABLE_ID) ? `strings-${id.slice(TABLE_ID.length)}` : undefined;
}

/** Кусок ядра одного языка: таблица готовой записью; без отбора — весь словарь языка */
export function languageModule(lang: Lang, only?: KeySelection): string {
  return `export default ${JSON.stringify(buildLanguageTable(UI_ENTRIES, ERROR_ENTRIES, lang, only))};\n`;
}

/** Модуль вместо src/dictionary/source.ts: без ожидания словаря нет, с ожиданием — кусок языка */
export function sourceModule(): string {
  const cases = LANGS.map((lang) => `    case ${JSON.stringify(lang)}: return import(${JSON.stringify(TABLE + lang)});`);
  return [
    "export function tableNow() { return null; }",
    "export function tableLater(lang) { return chunk(lang).then((m) => m.default); }",
    "function chunk(lang) {",
    "  switch (lang) {",
    ...cases,
    "  }",
    "  return Promise.reject(new Error(`quizzy-dictionary: ${lang}`));",
    "}",
    "",
  ].join("\n");
}

/** Строки модуля на всех языках, в порядке LANGS: так их читает registerStrings (src/dictionary/index.ts) */
function columns(entries: Readonly<Record<string, Entry>>, keys: Iterable<string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const key of [...keys].sort()) {
    const entry = entries[key];
    if (entry) out[key] = LANGS.map((lang) => entryText(entry, lang));
  }
  return out;
}

/** Модуль-фрагмент: строки одного модуля консоли на всех языках */
export function fragmentModule(keys: Keys): string {
  return (
    `import { registerStrings } from ${JSON.stringify(DICTIONARY)};\n` +
    `registerStrings(${JSON.stringify(columns(UI_ENTRIES, keys.ui))}, ${JSON.stringify(columns(ERROR_ENTRIES, keys.errors))});\n`
  );
}

/** Строки модуля, которых нет в ядре, — его фрагмент; null — фрагмент не нужен */
export function fragmentKeys(code: string, core: Keys): Keys | null {
  const { ui, errors } = keysIn(code);
  for (const k of core.ui) ui.delete(k);
  for (const k of core.errors) errors.delete(k);
  return ui.size || errors.size ? { ui, errors } : null;
}

/**
 * Скрипт предзагрузки куска языка: выбор — тем же правилом, что readSavedLang
 * в lang.tsx (сохранённый выбор, иначе detectLang по языкам браузера, а
 * недоступное хранилище — украинский). Ошибись он — пропадёт лишь
 * предзагрузка: кусок всё равно возьмёт import(), уже без подсказки.
 */
export function preloadScript(urls: Readonly<Record<Lang, string>>): string {
  return (
    "(function(m,d){var l;try{var s=localStorage.getItem(" +
    JSON.stringify(LANG_KEY) +
    ");l=Object.prototype.hasOwnProperty.call(m,s)?s:d(navigator.languages||[navigator.language])}catch(e){l=\"uk\"}" +
    'var k=document.createElement("link");k.rel="modulepreload";k.crossOrigin="";k.href=m[l];document.head.appendChild(k)})(' +
    `${JSON.stringify(urls)},${detectLang.toString()})`
  );
}

const isSource = (file: string) =>
  (file.startsWith(`${SRC}/`) || file.startsWith(`${SHARED}/`)) && /\.tsx?$/.test(file) && !/\.(test|d)\.tsx?$/.test(file);

export function dictionaryByLanguage(): Plugin {
  let build = false;
  let base = "/";
  let core: Keys | null = null;
  let initial = new Set<string>();
  const fragments = new Map<string, Keys>();
  return {
    name: "quizzy:dictionary-by-language",
    enforce: "pre",
    configResolved(config) {
      build = config.command === "build";
      base = config.base;
    },
    buildStart() {
      fragments.clear();
      if (!build) return;
      initial = initialModules();
      core = coreKeys(initial);
    },
    async resolveId(source, importer, options) {
      if (source.startsWith(TABLE) || source.startsWith(FRAGMENT)) return `\0${source}`;
      // дёшево отсеять всё, что не может быть src/dictionary/source.ts
      if (!importer || !/(^|\/)source(\.ts)?$/.test(source)) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && normalizePath(resolved.id) === SOURCE ? SOURCE_ID : null;
    },
    load(id) {
      if (id === SOURCE_ID) return sourceModule();
      if (id.startsWith(FRAGMENT_ID)) {
        const keys = fragments.get(id.slice(FRAGMENT_ID.length));
        if (!keys) this.error(`quizzy-strings: ${id}`);
        return fragmentModule(keys);
      }
      if (!id.startsWith(TABLE_ID)) return null;
      const lang = id.slice(TABLE_ID.length);
      if (!isLang(lang)) this.error(`quizzy-dictionary: ${lang}`);
      return languageModule(lang, core ?? undefined);
    },
    transform(code, id) {
      if (!build || !core || id.includes("?") || id.includes("\0")) return null;
      const file = normalizePath(id);
      if (!isSource(file) || initial.has(file) || DEFINITIONS.has(file) || file === SOURCE) return null;
      const keys = fragmentKeys(code, core);
      if (!keys) return null;
      const name = createHash("sha1").update(relative(WEB, file)).digest("hex").slice(0, 12);
      fragments.set(name, keys);
      /*
       * Импорт — в конце: объявления импорта всплывают, и фрагмент всё равно
       * выполнится раньше тела модуля, а строки исходника не сдвигаются —
       * карта исходников остаётся верной без пересчёта.
       */
      return { code: `${code}\nimport ${JSON.stringify(FRAGMENT + name)};\n`, map: null };
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        if (!ctx.bundle) return html; // dev-сервер: кусков ещё нет, догрузка и так рядом
        const urls = {} as Record<Lang, string>;
        for (const lang of LANGS) {
          const chunk = Object.values(ctx.bundle).find((c) => c.type === "chunk" && c.name === `strings-${lang}`);
          if (!chunk) throw new Error(`quizzy-dictionary: strings-${lang}`);
          urls[lang] = base + chunk.fileName;
        }
        /*
         * Сразу за <meta charset>, до таблицы стилей: встроенный скрипт после
         * неё ждал бы, пока доедут стили, и предзагрузка стартовала бы позже.
         */
        const tag = `<script>${preloadScript(urls)}</script>`;
        const charset = /<meta charset[^>]*>/i;
        return charset.test(html) ? html.replace(charset, (m) => m + tag) : html.replace("<head>", `<head>${tag}`);
      },
    },
  };
}
