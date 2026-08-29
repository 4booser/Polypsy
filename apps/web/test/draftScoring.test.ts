import { describe, expect, test } from "bun:test";
import { computeProfile, type Answer } from "@quizzy/shared";
import { draftToSurvey } from "../src/pages/constructor/model";
import type { Draft } from "../src/pages/constructor/model";

/**
 * Проверка ключа в редакторе.
 *
 * Считает общий движок `computeProfile` — он и так покрыт золотыми тестами.
 * Рискованное здесь другое: превращение черновика в методику. Ключ ссылается
 * на пункт по номеру, номера начинаются с единицы, и ошибка на единицу молча
 * считала бы соседний пункт — то есть проверка ключа подтверждала бы неверный
 * ключ. Именно это и проверяется.
 */

const loc = (ru: string) => ({ uk: ru, ru });

const question = (title: string, scores: number[]) => ({
  uid: crypto.randomUUID(),
  type: "single",
  title: loc(title),
  required: true,
  options: scores.map((score, i) => ({ text: loc(`вариант ${i + 1}`), score })),
});

const draft: Draft = {
  title: loc("Проба"),
  administration: "self",
  visibility: "public",
  scoringEnabled: true,
  allowRetake: true,
  showProgress: true,
  allowBack: true,
  anonymous: false,
  randomizeQuestions: false,
  sections: [],
  questions: [
    question("первый", [0, 10]),
    question("второй", [0, 100]),
    question("третий", [0, 1000]),
  ],
  scales: [
    {
      uid: crypto.randomUUID(),
      code: "S",
      title: loc("Шкала"),
      kind: "clinical",
      normalization: "raw",
      key: [{ item: 2 }],
      corrections: [],
      norms: [],
      stenTable: [],
      bands: [],
    },
  ],
} as unknown as Draft;

const answerAll = (optionIndex: number): Answer[] =>
  [1, 2, 3].map((n) => ({ questionId: `q${n}`, optionIds: [`q${n}o${optionIndex + 1}`] }));

describe("черновик как методика", () => {
  test("ключ на пункт 2 считает именно второй пункт", () => {
    /*
     * Веса подобраны так, чтобы промах на единицу был виден в самом числе:
     * 10 — первый пункт, 100 — второй, 1000 — третий. Сдвиг ключа нельзя
     * списать на округление.
     */
    const survey = draftToSurvey(draft, "ru");
    const profile = computeProfile(survey, answerAll(1));

    expect(profile.scores).toHaveLength(1);
    expect(profile.scores[0]!.rawScore).toBe(100);
  });

  test("невыбранные пункты не дают баллов", () => {
    const survey = draftToSurvey(draft, "ru");
    const profile = computeProfile(survey, answerAll(0));
    expect(profile.scores[0]!.rawScore).toBe(0);
  });

  test("ключ за пределами списка не роняет подсчёт", () => {
    /*
     * В редакторе пункт могли только что удалить, а ключ на него остаться.
     * Проверка обязана это пережить и показать результат по остальным: падение
     * посреди правки означало бы, что проверкой нельзя пользоваться именно
     * тогда, когда методика ещё собирается.
     */
    const broken: Draft = {
      ...draft,
      scales: [{ ...draft.scales[0]!, key: [{ item: 2 }, { item: 99 }] }],
    };
    const profile = computeProfile(draftToSurvey(broken, "ru"), answerAll(1));
    expect(profile.scores[0]!.rawScore).toBe(100);
  });

  test("текст берётся на языке интерфейса", () => {
    const survey = draftToSurvey(
      {
        ...draft,
        questions: [
          { ...draft.questions[0]!, title: { uk: "українською", ru: "по-русски" } },
          ...draft.questions.slice(1),
        ],
      },
      "uk",
    );
    expect(survey.questions[0]!.title).toBe("українською");
  });

  test("номера пунктов идут от единицы, как в ключе", () => {
    // если бы идентификаторы начинались с нуля, ключ «пункт 1» указывал бы
    // в пустоту, а «пункт 2» — на первый пункт
    const survey = draftToSurvey(draft, "ru");
    expect(survey.questions.map((q) => q.id)).toEqual(["q1", "q2", "q3"]);
    expect(survey.scales[0]!.items[0]!.questionId).toBe("q2");
  });
});
