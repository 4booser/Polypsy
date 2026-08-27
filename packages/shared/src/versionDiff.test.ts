import { describe, expect, test } from "bun:test";
import { diffVersions } from "./versionDiff";
import type { Option, Question, Scale, SurveyFull } from "./types";

/**
 * Проверяется главное: отличает ли сравнение правку, меняющую смысл балла,
 * от косметической. Ошибка в эту сторону дороже всего — она либо запретит
 * сравнивать сопоставимые замеры, либо разрешит сравнить несопоставимые.
 */

function option(id: string, text: string, keyCode: string, score: number): Option {
  return {
    id, questionId: "", text, keyCode, score, position: 0, kind: "option",
    riskFlag: false, riskLabel: null, riskSeverity: null,
  };
}

function question(id: string, title: string, extra: Partial<Question> = {}): Question {
  return {
    id, surveyId: "s", sectionId: null, type: "yesno", title, help: null,
    required: true, position: 0, scaleId: "sc1", reverseScored: false,
    options: [option(`${id}-y`, "Да", "yes", 1), option(`${id}-n`, "Нет", "no", 0)],
    ...extra,
  } as Question;
}

function band(minScore: number, maxScore: number) {
  return {
    id: "b", scaleId: "sc1", minScore, maxScore, label: "низкая",
    severity: "none", description: null,
  } as unknown as import("./types").ScaleBand;
}

function scale(items: { questionId: string; matchKey: string | null; weight: number }[], extra: Partial<Scale> = {}): Scale {
  return {
    id: "sc1", surveyId: "s", code: "Sr", title: "Склонность", description: null,
    aggregation: "sum", position: 0, kind: "clinical", normalization: "ratio",
    ratioDenominator: 35, validityThreshold: null, validityDirection: null,
    validityMessage: null,
    bands: [band(0, 10)],
    items, corrections: [], norms: [], stenTable: [],
    ...extra,
  } as Scale;
}

function survey(questions: Question[], scales: Scale[]): SurveyFull {
  return { questions, scales, sections: [], versionId: "v", versionNumber: 1 } as unknown as SurveyFull;
}

const q1 = question("q1", "Жизнь иногда хуже смерти");
const q2 = question("q2", "Я легко засыпаю");
const base = survey([q1, q2], [scale([{ questionId: "q1", matchKey: "yes", weight: 1 }])]);

describe("сравнение версий", () => {
  test("одинаковые версии сопоставимы и без изменений", () => {
    const d = diffVersions(base, survey([q1, q2], [scale([{ questionId: "q1", matchKey: "yes", weight: 1 }])]));
    expect(d.questions).toEqual([]);
    expect(d.scales).toEqual([]);
    expect(d.comparable).toBe(true);
  });

  test("опечатка в пояснении не делает версии несопоставимыми", () => {
    const after = survey(
      [q1, { ...q2, help: "уточнение" }],
      [scale([{ questionId: "q1", matchKey: "yes", weight: 1 }])],
    );
    const d = diffVersions(base, after);
    expect(d.questions.length).toBe(1);
    expect(d.questions[0]!.changes[0]!.scoring).toBe(false);
    expect(d.comparable).toBe(true);
  });

  test("переформулировка пункта делает версии несопоставимыми", () => {
    const after = survey(
      [q1, { ...q2, title: "Я засыпаю с трудом" }],
      [scale([{ questionId: "q1", matchKey: "yes", weight: 1 }])],
    );
    const d = diffVersions(base, after);
    expect(d.comparable).toBe(false);
    expect(d.reasons.join(" ")).toContain("влияющей на балл");
  });

  test("перестановка пунктов сопоставимости не ломает", () => {
    // сопоставление по id: вставка в начало не должна выглядеть заменой методики
    const after = survey(
      [{ ...q2, position: 0 }, { ...q1, position: 1 }],
      [scale([{ questionId: "q1", matchKey: "yes", weight: 1 }])],
    );
    const d = diffVersions(base, after);
    expect(d.questions.every((q) => q.kind === "changed")).toBe(true);
    expect(d.questions.every((q) => q.changes.every((c) => !c.scoring))).toBe(true);
    expect(d.comparable).toBe(true);
  });

  test("правка ключа шкалы видна и запрещает сравнение", () => {
    const after = survey([q1, q2], [scale([{ questionId: "q1", matchKey: "no", weight: 1 }])]);
    const d = diffVersions(base, after);
    const changed = d.scales.find((s) => s.code === "Sr")!;
    expect(changed.changes.map((c) => c.field)).toContain("ключ");
    expect(d.comparable).toBe(false);
  });

  test("сдвиг границ полосы интерпретации замечается", () => {
    const after = survey(
      [q1, q2],
      [scale([{ questionId: "q1", matchKey: "yes", weight: 1 }], {
        bands: [band(0, 12)],
      })],
    );
    const d = diffVersions(base, after);
    expect(d.scales[0]!.changes.map((c) => c.field)).toContain("полосы интерпретации");
    expect(d.comparable).toBe(false);
  });

  test("удалённый и добавленный пункт названы поимённо", () => {
    const q3 = question("q3", "Новый пункт");
    const after = survey([q1, q3], [scale([{ questionId: "q1", matchKey: "yes", weight: 1 }])]);
    const d = diffVersions(base, after);
    expect(d.questions.find((q) => q.kind === "removed")!.title).toBe("Я легко засыпаю");
    expect(d.questions.find((q) => q.kind === "added")!.title).toBe("Новый пункт");
    expect(d.reasons).toContain("убрано пунктов: 1");
    expect(d.reasons).toContain("добавлено пунктов: 1");
  });
});
