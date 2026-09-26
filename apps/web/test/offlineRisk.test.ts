import { describe, expect, test } from "bun:test";
import { evaluateSubmission } from "@quizzy/shared";
import { offlineSafetyPlan } from "../src/patient/outbox";
import { riskCases } from "../../../packages/shared/test/riskCases";

/**
 * Памятка безопасности без сети — тем же решением, что на сервере (волна 12).
 *
 * Кабинет проверял риск сам и по одному флагу варианта: числовой порог,
 * критический столбец матрицы и тяжёлая полоса шкалы карточки без сети не
 * давали. Набор случаев общий с тестом движка (packages/shared/test/
 * riskCases.ts) — каждый прогоняется и через памятку, и через
 * evaluateSubmission, которым считает сервер.
 */

const PLAN = "Зателефонуйте 7333";

describe("офлайн-памятка решает риск как сервер", () => {
  for (const c of riskCases()) {
    test(c.name, () => {
      const survey = { ...c.survey, safetyPlan: PLAN };
      const server = evaluateSubmission(survey, c.answers).risk.severity !== null;
      const shown = offlineSafetyPlan(survey, c.answers, null) !== null;
      expect(shown).toBe(server);
      expect(shown).toBe(c.expected !== null);
    });
  }

  test("нет плана у методики — нечего и показывать", () => {
    const c = riskCases().find((x) => x.name === "флаг варианта")!;
    expect(offlineSafetyPlan({ ...c.survey, safetyPlan: null }, c.answers, null)).toBeNull();
  });

  test("нормы — по полу и возрасту вошедшего: без них T-балла и полосы нет", () => {
    /*
     * Полоса T-шкалы назначается только после нормирования. Памятка берёт
     * пол и возраст того, кто вошёл, — иначе у шкал с нормами по полу она
     * молчала бы без сети при любом балле.
     */
    const c = riskCases().find((x) => x.name === "тяжёлая полоса шкалы")!;
    const scale = c.survey.scales[0]!;
    const tscore = {
      ...c.survey,
      safetyPlan: PLAN,
      scales: [
        {
          ...scale,
          normalization: "tscore" as const,
          norms: [{ sex: "male" as const, ageMin: null, ageMax: null, mean: 2, sd: 2, source: null }],
          bands: scale.bands.map((b) =>
            b.severity === "severe" ? { ...b, minScore: 70, maxScore: 200 } : { ...b, minScore: 0, maxScore: 69.9 },
          ),
        },
      ],
    };
    expect(offlineSafetyPlan(tscore, c.answers, { sex: "male", birthDate: "1990-01-01" })).toBe(PLAN);
    expect(offlineSafetyPlan(tscore, c.answers, null)).toBeNull();
  });
});
