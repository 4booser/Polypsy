import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import * as full from "../../../packages/shared/src/index";
import * as barrel from "../src/shared";

/**
 * Приложение берёт из общего пакета только нужное (волна 27, src/shared.ts).
 *
 * Было: `@quizzy/shared` — один вход на весь пакет, и Metro вёз в сборку
 * приложения и вычислял на старте его целиком: тексты ошибок и сообщений
 * сервера, права консоли, zod со схемами API и техпанели. Около полумегабайта
 * сборки, которых не зовёт ни один экран.
 *
 * Стало: `@quizzy/shared` в приложении — src/shared.ts (tsconfig.json,
 * paths), значения — из перечисленных там модулей. Здесь сверяется, что
 * подмена на месте, что всё, что приложение берёт, в ней есть, и что
 * тяжёлое в сборку не вернулось.
 */

const MOBILE = resolve(import.meta.dir, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

/** Значения (не типы), которые файл берёт из "@quizzy/shared" — импортом или реэкспортом */
function sharedValues(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const node of source.statements) {
    const from = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier;
    if (!from || !ts.isStringLiteral(from) || from.text !== "@quizzy/shared") continue;
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) out.push("default");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) if (!el.isTypeOnly) out.push((el.propertyName ?? el.name).text);
      } else if (bindings) out.push("*");
    } else {
      if (node.isTypeOnly) continue;
      const clause = node.exportClause;
      if (!clause) out.push("*");
      else if (ts.isNamedExports(clause)) for (const el of clause.elements) if (!el.isTypeOnly) out.push((el.propertyName ?? el.name).text);
    }
  }
  return out;
}

describe("общий пакет в приложении", () => {
  test("`@quizzy/shared` у приложения — src/shared.ts (tsc, Metro и bun идут по paths)", () => {
    const config = JSON.parse(readFileSync(join(MOBILE, "tsconfig.json"), "utf8"));
    expect(config.compilerOptions.paths["@quizzy/shared"]).toEqual(["./src/shared.ts"]);
  });

  test("всё, что экраны берут из пакета, в подмене есть — и то же самое, что в пакете", () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of [...files(join(MOBILE, "app")), ...files(join(MOBILE, "src"))]) {
      if (file.endsWith("/src/shared.ts")) continue;
      for (const name of sharedValues(file)) {
        seen++;
        if (name === "*" || name === "default" || !(name in barrel)) missing.push(`${file.slice(MOBILE.length + 1)}: ${name}`);
        else expect((barrel as Record<string, unknown>)[name], name).toBe((full as Record<string, unknown>)[name]);
      }
    }
    expect(seen).toBeGreaterThan(30);
    expect(missing, "значения нет в src/shared.ts — допиши туда его модуль").toEqual([]);
  });

  test("тяжёлое, что приложению не нужно, в сборку не возвращается", () => {
    const heavy = [
      "ERRORS", // errorStrings — тексты ошибок сервера
      "SERVER_TEXTS", // serverStrings
      "PUSH", // pushStrings — тексты push собирает сервер
      "ALL_PERMISSIONS", // права консоли
      "roleSchema", // schemas — zod, строится при загрузке
      "screenViewsSchema", // wireSchemas — zod
      "isDateInput", // dates — тянет zod
      "FEATURE_FLAGS", // featureFlags — тянет zod
      "mantelHaenszel", // medstats
    ];
    for (const name of heavy) {
      expect(name in full, `${name} пропал из пакета — обнови список`).toBe(true);
      expect(name in barrel, `${name} вернулся в сборку приложения`).toBe(false);
    }
  });
});
