import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * «Динаміка» рабочего места пациента (#199): график и подпись значения — в
 * одних единицах.
 *
 * rawScore точки динамики — вопреки имени T-балл или стен (routes/dynamics.ts),
 * maxScore — максимум сырого балла. Экран делил одно на другое: T 70 при
 * максимуме 16 давал ось 437 % и строку «70 з 16». Верх шкалы и «з N»
 * считаются в packages/shared (dynamicsPoint.ts, там же проверка на T-баллах
 * и стенах) — одной записью с мобилкой; здесь — что экраны на неё подписаны и
 * прежнего деления в них не осталось.
 */

const read = (f: string) => readFileSync(resolve(import.meta.dir, "../src/pages/patientCard", f), "utf8");
const dynamics = read("Dynamics.tsx");
const words = read("words.tsx");

describe("динамика пациента: график и подпись в одних единицах", () => {
  test("верх шкалы у графика курса — в единицах значений (pointValueTop)", () => {
    expect(dynamics).toContain("max={pointValueTop(last)}");
    expect(dynamics).not.toContain("max={last?.maxScore}");
  });

  test("«з N» — только у сырого балла, через pointValueTop, а не rawScore / maxScore", () => {
    expect(words).toContain('const top = units === "raw" ? pointValueTop(p) : null;');
    expect(words + dynamics).not.toMatch(/rawScore\s*\/\s*\w+\.maxScore/);
  });

  test("положительный контроль: график по-прежнему рисует значение точки", () => {
    // сами значения на графике — T-балл или стен, как и полосы; меняется только подпись
    expect(dynamics).toContain("courseFromDynamics(series, rungs)");
  });
});
