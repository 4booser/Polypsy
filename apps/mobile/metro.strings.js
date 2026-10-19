/**
 * Словарь оболочки в сборке приложения — только записи, до которых
 * приложение может дотянуться (волна 27).
 *
 * packages/shared/src/uiStrings.ts — общий словарь консоли и приложения:
 * около девяти тысяч записей на трёх языках, полтора мегабайта исходника.
 * Приложение зовёт из них меньше тысячи, а везло и создавало на старте все:
 * в веб-сборке это 2,8 МБ из 4,5 (Metro пишет кириллицу \uXXXX), в нативной —
 * строки в байткоде и объекты в памяти с первого кадра.
 *
 * Здесь собирается копия словаря с тем же кодом и только нужными записями;
 * metro.config.js подставляет её вместо uiStrings.ts в производственной
 * сборке (expo export, export:embed, EAS). В разработке, в tsc и в bun test —
 * полный словарь, как был: новая строка видна сразу, без перезапуска Metro.
 *
 * «Нужная» — по тому же правилу, по которому словарь чистят от мёртвых
 * ключей (apps/web/test/uiStrings.test.ts): ключ стоит в исходнике в кавычках
 * целиком или зовётся шаблоном `префикс.${…}`. Исходники — экраны и модули
 * приложения и весь общий пакет (ключи бывают в его таблицах: SEVERITY_KEY).
 * Правило шире, чем вызовы ut(): лишняя запись стоит байтов, пропущенная —
 * ключа на экране вместо текста. Проверка — test/stringsSubset.test.ts.
 *
 * Не узнал устройство словаря (его переписали, `UI` больше не литерал) —
 * копии нет, и сборка берёт полный словарь: дороже, но ничего не теряется.
 */
const fs = require("fs");
const path = require("path");

const MOBILE = __dirname;
const SHARED = path.resolve(MOBILE, "../../packages/shared/src");
const DICTIONARY = path.join(SHARED, "uiStrings.ts");
/** .expo/ — вне истории; Metro его видит (закрыты только .expo/types и .expo/web/cache) */
const OUT = path.join(MOBILE, ".expo/strings/uiStrings.ts");

function codeFiles(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules") continue;
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) out.push(...codeFiles(file));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(file);
  }
  return out;
}

/** Где приложение берёт ключи: свои экраны и модули и весь общий пакет, кроме самого словаря */
function appSources() {
  return [...codeFiles(path.join(MOBILE, "app")), ...codeFiles(path.join(MOBILE, "src")), ...codeFiles(SHARED)].filter(
    (file) => file !== DICTIONARY,
  );
}

/** Литерал словаря `export const UI = { … }` (под `as const satisfies …`); null — устройство не узнано */
function dictionaryObject(ts, file) {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of statement.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "UI" || !d.initializer) continue;
      let init = d.initializer;
      while (ts.isSatisfiesExpression(init) || ts.isAsExpression(init) || ts.isParenthesizedExpression(init)) init = init.expression;
      return ts.isObjectLiteralExpression(init) ? init : null;
    }
  }
  return null;
}

/**
 * Записи словаря: ключ и его кусок исходника; null — запись не простого
 * вида (вычисляемый ключ, разворот). Разбор — компилятором TypeScript:
 * он у приложения в зависимостях, и разбирает так же, как tsc.
 */
function entriesOf(source) {
  const ts = require("typescript");
  const file = ts.createSourceFile("uiStrings.ts", source, ts.ScriptTarget.Latest, true);
  const object = dictionaryObject(ts, file);
  if (!object) return null;
  const entries = [];
  for (const p of object.properties) {
    if (!ts.isPropertyAssignment(p) || !ts.isStringLiteral(p.name)) return null;
    entries.push({ key: p.name.text, text: source.slice(p.getStart(file), p.end) });
  }
  return { start: object.getStart(file), end: object.end, entries };
}

/** Ключи, до которых дотягиваются исходники: целиком в кавычках или семейством шаблона */
function reachableKeys(keys, sources) {
  const text = sources.map((file) => fs.readFileSync(file, "utf8")).join("\n");
  const quoted = new Set([...text.matchAll(/["'`]([A-Za-z0-9_.-]+)["'`]/g)].map((m) => m[1]));
  const prefixes = [...new Set([...text.matchAll(/`([a-z][A-Za-z0-9.]*)\.\$\{/g)].map((m) => m[1]))];
  return new Set(keys.filter((key) => quoted.has(key) || prefixes.some((p) => key.startsWith(`${p}.`))));
}

/**
 * Исходник словаря только с записями `keep` — код вокруг литерала тот же
 * (makeUiT, uiText, detectLang…). null — устройство словаря не узнано.
 */
function subsetSource(source, keep) {
  const parsed = entriesOf(source);
  if (!parsed) return null;
  const kept = parsed.entries.filter((e) => keep(e.key));
  if (!kept.length) return null;
  return `${source.slice(0, parsed.start)}{\n  ${kept.map((e) => e.text).join(",\n  ")},\n}${source.slice(parsed.end)}`;
}

/** Собрать копию словаря для сборки приложения; null — не вышло, сборка берёт полный */
function buildMobileStrings({ out = OUT, sources = appSources() } = {}) {
  const source = fs.readFileSync(DICTIONARY, "utf8");
  const parsed = entriesOf(source);
  if (!parsed) return null;
  const keep = reachableKeys(
    parsed.entries.map((e) => e.key),
    sources,
  );
  const subset = subsetSource(source, (key) => keep.has(key));
  if (!subset) return null;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `// Собрано apps/mobile/metro.strings.js для сборки приложения — не править.\n${subset}`);
  return { file: out, kept: keep.size, total: parsed.entries.length };
}

module.exports = { DICTIONARY, OUT, appSources, buildMobileStrings, reachableKeys, subsetSource };
