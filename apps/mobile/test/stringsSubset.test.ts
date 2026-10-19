import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import * as full from "../../../packages/shared/src/uiStrings";

/**
 * Словарь в производственной сборке приложения (волна 27, metro.strings.js).
 *
 * Сборка берёт копию общего словаря только с записями, до которых
 * дотягивается приложение: ключ в кавычках целиком или семейство шаблона
 * `префикс.${…}`. Пропущенная запись — это ключ вместо текста на экране, и
 * увидеть её можно только в сборке: разработка и тесты читают полный
 * словарь. Поэтому здесь копия сверяется с исходниками другим способом —
 * разбором компилятором, а не регуляркой генератора.
 */

// генератор — модуль CommonJS: его грузит metro.config.js
const strings = require("../metro.strings.js") as {
  DICTIONARY: string;
  buildMobileStrings: (o?: { out?: string }) => { file: string; kept: number; total: number } | null;
  subsetSource: (source: string, keep: (key: string) => boolean) => string | null;
};

const MOBILE = resolve(import.meta.dir, "..");
const SHARED = resolve(MOBILE, "../../packages/shared/src");
const dir = mkdtempSync(join(tmpdir(), "mobile-strings-"));
const out = join(dir, "uiStrings.ts");
let built: { file: string; kept: number; total: number } | null = null;
let subset: typeof full;

beforeAll(async () => {
  built = strings.buildMobileStrings({ out });
  subset = (await import(out)) as typeof full;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function files(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    if (name === "node_modules") return [];
    const p = join(root, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Строковые литералы и головы шаблонов исходника — разбором, а не регуляркой */
function literals(file: string): { strings: string[]; heads: string[] } {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found = { strings: [] as string[], heads: [] as string[] };
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) found.strings.push(node.text);
    if (ts.isTemplateExpression(node)) found.heads.push(node.head.text);
    ts.forEachChild(node, walk);
  };
  walk(source);
  return found;
}

const keys = Object.keys(full.UI);

describe("словарь сборки приложения", () => {
  test("собирается, и записей в нём в разы меньше полного", () => {
    expect(built, "устройство uiStrings.ts не узнано — сборка пойдёт с полным словарём").not.toBeNull();
    expect(built!.total).toBe(keys.length);
    expect(built!.kept).toBeGreaterThan(300);
    expect(built!.kept).toBeLessThan(keys.length / 3);
  });

  test("тот же код: те же имена, и перевод по каждой записи копии — тот же", () => {
    expect(Object.keys(subset).sort()).toEqual(Object.keys(full).sort());
    for (const key of Object.keys(subset.UI)) {
      expect((subset.UI as Record<string, unknown>)[key], key).toEqual((full.UI as Record<string, unknown>)[key]);
      for (const lang of ["uk", "ru", "en"] as const) {
        expect(subset.makeUiT(lang)(key as never)).toBe(full.makeUiT(lang)(key as never));
      }
    }
    expect(subset.detectLang(["ru-RU"])).toBe("ru");
  });

  test("каждый ключ, который стоит в исходниках приложения и общего пакета литералом, — в копии", () => {
    const inSubset = new Set(Object.keys(subset.UI));
    const sources = [...files(join(MOBILE, "app")), ...files(join(MOBILE, "src")), ...files(SHARED)].filter(
      (f) => f !== strings.DICTIONARY,
    );
    const known = new Set(keys);
    const missing = new Set<string>();
    const families = new Set<string>();
    for (const file of sources) {
      const { strings: lits, heads } = literals(file);
      for (const s of lits) if (known.has(s) && !inSubset.has(s)) missing.add(`${file.slice(MOBILE.length + 1)}: ${s}`);
      for (const h of heads) if (/^[a-z][A-Za-z0-9.]*\.$/.test(h)) families.add(h);
    }
    expect([...missing], "ключ приложения не попал в словарь сборки").toEqual([]);
    // шаблонные ключи (`mst.kind.${kind}`) — семейство целиком
    expect(families.size).toBeGreaterThan(3);
    for (const prefix of families) {
      const family = keys.filter((k) => k.startsWith(prefix));
      expect(
        family.filter((k) => !inSubset.has(k)),
        `семейство ${prefix}* неполное`,
      ).toEqual([]);
    }
  });

  test("словарь, которого генератор не узнал, — не копия, а полный (null)", () => {
    expect(strings.subsetSource("export const UI = makeDictionary();", () => true)).toBeNull();
    expect(strings.subsetSource('export const UI = { ["a"]: { uk: "", ru: "", en: "" } };', () => true)).toBeNull();
    expect(strings.subsetSource('export const UI = { ...BASE, "a": { uk: "", ru: "", en: "" } };', () => true)).toBeNull();
    expect(strings.subsetSource('export const UI = { "a": { uk: "", ru: "", en: "" } } as const;', () => false)).toBeNull();
    expect(
      strings.subsetSource('export const UI = { "a": { uk: "1", ru: "1", en: "1" }, "b": { uk: "2", ru: "2", en: "2" } } as const;', (k) => k === "b"),
    ).toBe('export const UI = {\n  "b": { uk: "2", ru: "2", en: "2" },\n} as const;');
  });

  test("подставляется только в производственной сборке — Metro, а не tsc и не тесты", () => {
    const config = readFileSync(join(MOBILE, "metro.config.js"), "utf8");
    expect(config).toContain('process.env.NODE_ENV === "production"');
    expect(config).toContain("buildMobileStrings()");
    // tsc и bun берут полный словарь: подмена — не через paths
    const ts = JSON.parse(readFileSync(join(MOBILE, "tsconfig.json"), "utf8"));
    expect(JSON.stringify(ts.compilerOptions.paths)).not.toContain("strings");
  });
});
