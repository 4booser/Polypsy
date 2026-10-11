import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Вкладка «Динамика» карты пациента (#199): профиль и «Останній замір» — в
 * одних единицах.
 *
 * rawScore точки динамики — вопреки имени T-балл или стен (routes/dynamics.ts),
 * maxScore — максимум сырого балла. Экран делил одно на другое: T 70 при
 * максимуме 16 давал ось профиля 437 % и строку «70 з 16». Доля и подпись
 * теперь считаются в packages/shared (dynamicsPoint.ts, там же проверка на
 * T-баллах и стенах) — одной записью с мобилкой; здесь — что экран на неё
 * подписан и прежнего деления в нём не осталось.
 */

const src = readFileSync(resolve(import.meta.dir, "../src/pages/Patients.tsx"), "utf8");
const dynamics = src.slice(src.indexOf("export function PatientDynamics"));

describe("динамика пациента: доля и подпись в одних единицах", () => {
  test("профиль строится из pointShare, а не из rawScore / maxScore", () => {
    expect(dynamics).toContain("pointShare(p)");
    expect(dynamics).not.toMatch(/rawScore\s*\/\s*p\.maxScore/);
  });

  test("«Останній замір» — pointValueText, а не «rawScore з maxScore»", () => {
    expect(dynamics).toContain("pointValueText(last");
    expect(dynamics).not.toMatch(/\{last\.rawScore\}\s*\{ut\("an\.of"\)\}\s*\{last\.maxScore\}/);
  });

  test("полная шкала под графиком — в единицах значений (pointValueTop)", () => {
    expect(dynamics).toContain("fullRange={last ? pointValueTop(last) : null}");
    expect(dynamics).not.toContain("fullRange={last?.maxScore}");
  });

  test("положительный контроль: график по-прежнему рисует значение точки", () => {
    // сами значения на графике — T-балл или стен, как и полосы; меняются только доля и подписи
    expect(dynamics).toContain("p.rawScore,");
  });
});
