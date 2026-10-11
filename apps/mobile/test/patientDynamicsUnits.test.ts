import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pointShare, pointValueText, pointValueTop } from "@quizzy/shared";

/**
 * Экран аналитики пациента (#199): профиль и «Останній замір» — в одних
 * единицах, и так же, как в консоли.
 *
 * rawScore точки динамики — T-балл или стен, maxScore — максимум сырого
 * балла. Экран делил одно на другое (T 70 / 16 — 437 %), подписывал «70 з 16»
 * и тянул ось графика до максимума сырого балла, хотя значения на нём — стены
 * или T-баллы. Доля, верх и подпись — общие с консолью (packages/shared,
 * dynamicsPoint.ts).
 */

const src = readFileSync(resolve(import.meta.dir, "../app/analytics/patients/[userId].tsx"), "utf8");
const labels = { of: "з", norm: { raw: "сирий бал", ratio: "частка", tscore: "T-бал", sten: "стен" } };

describe("мобилка: доля и подпись в одних единицах", () => {
  test("профиль строится из pointShare, а не из rawScore / maxScore", () => {
    expect(src).toContain("pointShare(p)");
    expect(src).not.toMatch(/rawScore\s*\/\s*p\.maxScore/);
  });

  test("«Останній замір» — pointValueText, а не «rawScore з maxScore»", () => {
    expect(src).toContain("pointValueText(last");
    expect(src).not.toContain('String(last.rawScore)).replace("{max}", String(last.maxScore))');
  });

  test("верх оси графика — в единицах значений (pointValueTop)", () => {
    expect(src).toContain("pointValueTop(last)");
    expect(src).not.toContain("yMax={last?.maxScore");
  });

  test("T-балл: доля — по сырому баллу, подпись — T-балл, верха нет", () => {
    const t = { rawScore: 70, maxScore: 16, percent: 62.5, normalized: true, normalization: "tscore" as const };
    expect(pointShare(t)).toBe(0.625);
    expect(pointValueTop(t)).toBeNull();
    expect(pointValueText(t, labels)).toBe("T-бал 70");
  });

  test("стен: доля — по сырому баллу, верх — 10", () => {
    const s = { rawScore: 7, maxScore: 16, percent: 50, normalized: true, normalization: "sten" as const };
    expect(pointShare(s)).toBe(0.5);
    expect(pointValueTop(s)).toBe(10);
    expect(pointValueText(s, labels)).toBe("стен 7");
  });

  test("положительный контроль: сырая шкала — «12 з 16», верх — максимум", () => {
    const raw = { rawScore: 12, maxScore: 16, percent: 75, normalized: true, normalization: "raw" as const };
    expect(pointShare(raw)).toBe(0.75);
    expect(pointValueTop(raw)).toBe(16);
    expect(pointValueText(raw, labels)).toBe("12 з 16");
  });
});
