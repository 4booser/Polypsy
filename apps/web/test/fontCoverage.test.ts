import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Сторож: символы интерфейса покрыты локальными шрифтами.
 *
 * CSP закрыт, шрифты — свои подмножества с unicode-range. Символ вне
 * диапазонов рисует системный запасной шрифт, а он у каждого свой: смена
 * образа раннера GitHub перерисовала «←», «→» и «▸», и эталоны экранов
 * покраснели без единой правки кода. Это не только про эталоны: читатель
 * на Linux видит другую стрелку, чем на macOS, — то есть не тот интерфейс,
 * что нарисован.
 *
 * Проверяется исходник, а не страница: так видны все экраны сразу, а не
 * те, что открыл сценарий. Комментарии вырезаются — в них символы стоят
 * законно. Известный долг перечислен поимённо, чтобы новый символ не
 * проскочил: список обязан только уменьшаться.
 */

const WEB = resolve(import.meta.dir, "../src");
const STRINGS = resolve(import.meta.dir, "../../../packages/shared/src/uiStrings.ts");

/** Диапазоны из fonts.css: «U+0400-045F, U+2116» → [[0x400, 0x45f], [0x2116, 0x2116]] */
function coveredRanges(): Array<[number, number]> {
  const css = readFileSync(join(WEB, "styles/fonts.css"), "utf8");
  const out: Array<[number, number]> = [];
  for (const m of css.matchAll(/unicode-range:\s*([^;]+);/g)) {
    for (const part of m[1]!.split(",")) {
      const r = part.trim().match(/^U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?$/);
      if (!r) throw new Error(`fonts.css: непонятный диапазон «${part.trim()}»`);
      const from = Number.parseInt(r[1]!, 16);
      out.push([from, r[2] ? Number.parseInt(r[2], 16) : from]);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(tsx?|css)$/.test(path)) out.push(path);
  }
  return out;
}

/** Комментарии вон: блочные целиком, строчные — до конца строки */
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/*
 * Известный долг — символы, которые ещё рисует запасной шрифт. Каждый
 * заменяется на значок из ui/glyphs.tsx или на символ из подмножества и
 * вычёркивается отсюда. Добавлять сюда нельзя: новый символ — новый значок.
 */
const KNOWN_DEBT = new Set(["✕", "⚠", "✖", "★", "↶", "↷", "↵", "⌘", "⧉", "└", "─", "α"]);

describe("символы интерфейса покрыты локальными шрифтами", () => {
  const ranges = coveredRanges();
  const covered = (cp: number) => cp < 0x80 || ranges.some(([a, b]) => cp >= a && cp <= b);

  test("вне диапазонов fonts.css — только известный долг", () => {
    const offenders = new Map<string, string[]>();
    for (const file of [...sourceFiles(WEB), STRINGS]) {
      const src = stripComments(readFileSync(file, "utf8"));
      src.split("\n").forEach((line, i) => {
        for (const ch of line) {
          const cp = ch.codePointAt(0)!;
          if (covered(cp) || KNOWN_DEBT.has(ch)) continue;
          const list = offenders.get(ch) ?? [];
          if (list.length < 3) list.push(`${file.replace(`${WEB}/`, "")}:${i + 1}`);
          offenders.set(ch, list);
        }
      });
    }
    const report = [...offenders].map(([ch, where]) => `«${ch}» U+${ch.codePointAt(0)!.toString(16)} — ${where.join(", ")}`);
    expect(report, "символ вне локальных шрифтов: замени на значок из ui/glyphs.tsx или добавь в подмножество").toEqual([]);
  });

  test("подмножество символов подключено и лежит рядом с остальными", () => {
    const css = readFileSync(join(WEB, "styles/fonts.css"), "utf8");
    expect(css).toContain("Onest-symbols.woff2");
    expect(statSync(resolve(WEB, "../public/fonts/Onest-symbols.woff2")).size).toBeGreaterThan(500);
    // стрелки крошек и цепочки порядка — в диапазоне подмножества
    for (const cp of [0x2190, 0x2192]) expect(covered(cp), `U+${cp.toString(16)} не покрыт`).toBe(true);
  });
});
