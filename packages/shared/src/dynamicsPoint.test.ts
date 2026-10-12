import { describe, expect, test } from "bun:test";
import { pointShare, pointValueText, pointValueTop } from "./dynamicsPoint";
import { computeProfile } from "./scoring";
import type { DynamicsPoint } from "./types";

/**
 * Точка динамики на экране пациента (#199): доля для профиля и подпись
 * «останній замір» — в одних единицах.
 *
 * Точка собирается так же, как её собирает routes/dynamics.ts: rawScore —
 * score.value (T-балл, стен), maxScore и percent — из того же результата.
 * Прежде экраны делили rawScore на maxScore: T 70 при максимуме 16 — 437 %,
 * стен при максимуме 16 — заниженная доля.
 */

function survey(normalization: "tscore" | "sten") {
  const ids = Array.from({ length: 16 }, (_, i) => `q${i}`);
  const questions = ids.map((id) => ({
    id,
    type: "yesno" as const,
    title: { ru: id },
    required: false,
    reverseScored: false,
    options: [
      { id: `${id}-y`, text: { ru: "Да" }, score: 1, keyCode: "yes" },
      { id: `${id}-n`, text: { ru: "Нет" }, score: 0, keyCode: "no" },
    ],
  }));
  return {
    id: "s",
    questions,
    scales: [
      {
        id: "A",
        code: "A",
        title: { ru: "Тревога" },
        kind: "clinical" as const,
        aggregation: "sum" as const,
        normalization,
        ratioDenominator: null,
        validityThreshold: null,
        validityDirection: "above" as const,
        validityMessage: null,
        corrections: [],
        norms: [{ sex: null, ageMin: null, ageMax: null, mean: 6, sd: 2, source: "пособие" }],
        stenTable: [
          { sex: null, ageMin: null, ageMax: null, rawMin: 0, rawMax: 5, sten: 3 },
          { sex: null, ageMin: null, ageMax: null, rawMin: 6, rawMax: 11, sten: 7 },
          { sex: null, ageMin: null, ageMax: null, rawMin: 12, rawMax: 16, sten: 10 },
        ],
        bands: [],
        items: ids.map((questionId) => ({ questionId, weight: 1, matchKey: "yes" })),
      },
    ],
  } as never;
}

/** Ответы «да» на первые yes пунктов из 16 */
const answers = (yes: number) =>
  Array.from({ length: 16 }, (_, i) => ({ questionId: `q${i}`, optionIds: [i < yes ? `q${i}-y` : `q${i}-n`] }));

/** Точка так, как её отдаёт /api/dynamics */
function pointOf(normalization: "tscore" | "sten", yes: number, sex: "male" | null = "male"): DynamicsPoint {
  const s = computeProfile(survey(normalization), answers(yes) as never, { sex, age: 30 }).scores[0]!;
  return {
    responseId: "r",
    submittedAt: "2026-10-01T10:00:00Z",
    rawScore: s.value,
    maxScore: s.maxScore,
    percent: s.percent,
    bandLabel: null,
    severity: null,
    percentile: null,
    normalized: s.normalized,
    normalization: s.normalization,
  };
}

const labels = {
  of: "из",
  norm: { raw: "сырой балл", ratio: "доля", tscore: "T-балл", sten: "стен" },
};

describe("T-баллы", () => {
  test("доля — сырой балл против максимума, а не T-балл против максимума", () => {
    const p = pointOf("tscore", 10);
    expect(p.rawScore).toBe(70);
    expect(p.maxScore).toBe(16);
    // прежде 70 / 16 = 4.375 — ось профиля упиралась в край
    expect(pointShare(p)).toBeCloseTo(10 / 16, 2);
  });

  test("подпись — T-балл своим словом, без «из 16»", () => {
    expect(pointValueText(pointOf("tscore", 10), labels)).toBe("T-балл 70");
  });

  test("у T-балла верха нет: полная шкала не подписывается максимумом сырого балла", () => {
    expect(pointValueTop(pointOf("tscore", 10))).toBeNull();
  });

  test("не нормирована (нормы для пола нет) — сырой балл из максимума", () => {
    const survey2 = survey("tscore") as { scales: { norms: { sex: string | null }[] }[] };
    survey2.scales[0]!.norms[0]!.sex = "female";
    const s = computeProfile(survey2 as never, answers(10) as never, { sex: "male", age: 30 }).scores[0]!;
    const p: DynamicsPoint = {
      ...pointOf("tscore", 10),
      rawScore: s.value,
      normalized: s.normalized,
    };
    expect(p.normalized).toBe(false);
    expect(pointValueText(p, labels)).toBe("10 из 16");
    expect(pointValueTop(p)).toBe(16);
    expect(pointShare(p)).toBeCloseTo(10 / 16, 2);
  });
});

describe("стены", () => {
  test("доля — сырой балл против максимума, а не стен против максимума", () => {
    const p = pointOf("sten", 14);
    expect(p.rawScore).toBe(10);
    // прежде 10 / 16 — профиль проседал при максимальном стене
    expect(pointShare(p)).toBeCloseTo(14 / 16, 2);
    const low = pointOf("sten", 2);
    expect(low.rawScore).toBe(3);
    // прежде 3 / 16: при двух баллах из шестнадцати доля выходила выше настоящей
    expect(pointShare(low)).toBeCloseTo(2 / 16, 2);
  });

  test("подпись — стен своим словом, верх шкалы — 10", () => {
    const p = pointOf("sten", 8);
    expect(pointValueText(p, labels)).toBe("стен 7");
    expect(pointValueTop(p)).toBe(10);
  });
});

describe("положительный контроль", () => {
  test("сырая шкала: «12 из 16», верх — максимум, доля как прежде", () => {
    const p: DynamicsPoint = {
      responseId: "r",
      submittedAt: "2026-10-01T10:00:00Z",
      rawScore: 12,
      maxScore: 16,
      percent: 75,
      bandLabel: null,
      severity: null,
      percentile: null,
      normalized: true,
      normalization: "raw",
    };
    expect(pointValueText(p, labels)).toBe("12 из 16");
    expect(pointValueTop(p)).toBe(16);
    expect(pointShare(p)).toBe(0.75);
  });

  test("ответ старого сервера без единиц — показывается сырым, как прежде", () => {
    const p = { rawScore: 5, maxScore: 10, percent: 50 };
    expect(pointValueText(p, labels)).toBe("5 из 10");
    expect(pointShare(p)).toBe(0.5);
  });

  test("доля не выходит за 0–1", () => {
    expect(pointShare({ percent: 130 })).toBe(1);
    expect(pointShare({ percent: -5 })).toBe(0);
    expect(pointShare({ percent: Number.NaN })).toBe(0);
  });
});
