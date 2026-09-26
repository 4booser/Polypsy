import { describe, expect, test } from "bun:test";
import { resultView, type ResultInput } from "../src/runner/resultView";

/**
 * Экран после сдачи не показывает пациенту то, что методика запретила.
 *
 * Дефект клинического ревью: у PHQ-9, PCL-5, PQ-16 флаг showResultsToPatient
 * снят, а мобилка показывала баллы, полосы и «Відкрити висновок» — и при
 * онлайн-сдаче, и офлайн, где баллы считаются на устройстве.
 */

const base: ResultInput = {
  showResultsToPatient: false,
  scoringEnabled: true,
  onBehalfOf: false,
  queued: false,
  scoresCount: 3,
  responseId: "resp-1",
  safetyPlan: null,
};

describe("проходит сам пациент, флаг снят", () => {
  test("онлайн: ни баллов, ни «висновку» — строка о том, почему", () => {
    const view = resultView(base);
    expect(view.scores).toBe(false);
    expect(view.conclusion).toBe(false);
    expect(view.hiddenNote).toBe(true);
    expect(view.tookKey).toBe("msv.tookSaved");
  });

  test("офлайн: посчитанное на устройстве тоже не показывается, и строка не обещает «бали нижче»", () => {
    const view = resultView({ ...base, queued: true, responseId: "queue-7" });
    expect(view.scores).toBe(false);
    expect(view.conclusion).toBe(false);
    expect(view.tookKey).toBe("msv.tookQueuedNoScores");
  });

  test("кризисная карточка при риске остаётся", () => {
    const plan = "Зателефонуйте на лінію 7333";
    expect(resultView({ ...base, safetyPlan: plan }).safetyPlan).toBe(plan);
    expect(resultView({ ...base, queued: true, safetyPlan: plan }).safetyPlan).toBe(plan);
  });

  test("методика без подсчёта — и объяснять нечего", () => {
    expect(resultView({ ...base, scoringEnabled: false, scoresCount: 0 }).hiddenNote).toBe(false);
  });
});

describe("когда показывать можно", () => {
  test("флаг включён — баллы и «висновок», как было", () => {
    const view = resultView({ ...base, showResultsToPatient: true });
    expect(view.scores).toBe(true);
    expect(view.conclusion).toBe(true);
    expect(view.hiddenNote).toBe(false);
  });

  test("за пациента заполняет специалист (обход) — результат для него, флаг не мешает", () => {
    const view = resultView({ ...base, onBehalfOf: true });
    expect(view.scores).toBe(true);
    expect(view.conclusion).toBe(true);
  });

  test("офлайн-сдача: баллы с устройства — да, «висновок» — нет (id — номер в очереди)", () => {
    const view = resultView({ ...base, showResultsToPatient: true, queued: true, responseId: "queue-7" });
    expect(view.scores).toBe(true);
    expect(view.conclusion).toBe(false);
    expect(view.tookKey).toBe("msv.tookQueued");
  });

  test("баллов нет — и карточки нет, и «бали нижче» не обещается", () => {
    const view = resultView({ ...base, showResultsToPatient: true, queued: true, scoresCount: 0 });
    expect(view.scores).toBe(false);
    expect(view.tookKey).toBe("msv.tookQueuedNoScores");
  });
});
