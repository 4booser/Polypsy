import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fill, stepsOfBands } from "../src/pages/printSheet";
import { PRINT_SHEET } from "../src/print";

/**
 * Печатный лист консоли (ключ методики, пустой бланк; UI 3, v2-print).
 *
 * Лист стоит на экране предпросмотром, а на бумагу идёт он один — и кнопкой,
 * и Ctrl+P: правило печати в наследии убирает всё вокруг него. Рамка консоли
 * высотой в экран со своей прокруткой на бумаге обрезала бы хвост листа и
 * карты пациента — на печати колонки рамки становятся блоками.
 */

const LEGACY = readFileSync(resolve(import.meta.dir, "../src/styles/legacy.css"), "utf8");
const printBlocks = [...LEGACY.matchAll(/@media print \{/g)].map((m) => LEGACY.slice(m.index, m.index + 4000)).join("\n");

describe("печатный лист консоли", () => {
  test("на бумагу идёт только лист, рамка консоли не режет его", () => {
    expect(PRINT_SHEET).toBe("data-print-sheet");
    expect(printBlocks).toContain("body:has([data-print-sheet]) *:not([data-print-sheet], [data-print-sheet] *, :has([data-print-sheet]))");
    expect(printBlocks).toContain("#root :is(.h-screen, .main, .min-h-0.flex-1, .flex-col:has(> .min-h-0.flex-1))");
    expect(printBlocks).toContain("#root .overflow-y-auto");
  });

  test("выраженность — словом в обводке ступени, а не заливкой", () => {
    expect(LEGACY).toMatch(/\.ps-sev \{[^}]*border: 1px solid currentColor/);
    for (const step of [0, 1, 2, 3, 4]) expect(LEGACY).toContain(`.ps-sev.l${step} { color: var(--sev-${step}); }`);
  });

  test("две тяжёлые полосы подряд различаются ступенью, как на листах сервера", () => {
    const phq = ["none", "mild", "moderate", "severe", "severe"].map((severity) => ({ severity }));
    expect(stepsOfBands(phq)).toEqual([0, 1, 2, 3, 4]);
    expect(stepsOfBands(["severe", "severe", "none"].map((severity) => ({ severity })))).toEqual([4, 3, 0]);
  });

  test("подстановка в строку словаря", () => {
    expect(fill("Сторінка {page} з {pages}", { page: 2, pages: 5 })).toBe("Сторінка 2 з 5");
  });
});
