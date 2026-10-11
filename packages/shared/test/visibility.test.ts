import { describe, expect, test } from "bun:test";
import { computeProfile, isQuestionVisible } from "../src/scoring";
import { countedAnswers, evaluateSubmission } from "../src/risk";
import type { Answer, Question } from "../src/types";
import { answerYesNo, makeScale, makeSurvey, rule, yesNoQuestion } from "./fixtures";

/*
 * Условие показа транзитивно (#135): ответ источника, скрытого своим
 * условием, для правила не считается. Одна функция для экрана (веб, мобилка),
 * проверки обязательности на сервере, countedAnswers и computeProfile.
 */

/**
 * Q1 «думки?» → Q2 показ при «так» в Q1 → Q3 «є план?» (тяжёлый) показ при
 * ответе на Q2. Цепочка без дублирования условий — как в методиках
 * конструктора и импорта.
 */
function chain() {
  const q1 = yesNoQuestion(0);
  const q2 = yesNoQuestion(1);
  q2.logic = [{ ...rule(q1, { operator: "contains", value: q1.options[0]!.id }), questionId: q2.id }];
  const q3 = yesNoQuestion(2);
  q3.options = q3.options.map((o) =>
    o.keyCode === "yes" ? { ...o, riskFlag: true, riskSeverity: "severe" as const, riskLabel: "Є план" } : o,
  );
  q3.logic = [{ ...rule(q2, { operator: "answered" }), questionId: q3.id }];
  const scale = makeScale({ code: "R", items: [q3].map((q) => ({ questionId: q.id, matchKey: "yes", weight: 1 })) });
  return { q1, q2, q3, survey: makeSurvey([q1, q2, q3], [scale]) };
}

const mapOf = (answers: Answer[]) => new Map(answers.map((a) => [a.questionId, a]));

/** Тело сдачи по клиентскому правилу: только ответы на показанные пункты (Runner, мобилка, administerPayload) */
function clientBody(questions: Question[], answers: Answer[]): Answer[] {
  const all = mapOf(answers);
  return answers.filter((a) => {
    const q = questions.find((x) => x.id === a.questionId)!;
    return isQuestionVisible(q, questions, all);
  });
}

describe("транзитивная видимость (#135)", () => {
  test("ответили всё, сменили Q1 на «ні»: Q3 скрыт на экране, хотя старый ответ Q2 в памяти формы", () => {
    const { q1, q2, q3, survey } = chain();
    const answers = [answerYesNo(q1, false), answerYesNo(q2, true), answerYesNo(q3, true)];
    const all = mapOf(answers);
    expect(isQuestionVisible(q2, survey.questions, all)).toBe(false);
    expect(isQuestionVisible(q3, survey.questions, all), "Q3 держится старым ответом скрытого Q2").toBe(false);
  });

  test("тело по клиентскому правилу сервер читает так же: ни один показанный пункт не отброшен", () => {
    const { q1, q2, q3, survey } = chain();
    const answers = [answerYesNo(q1, false), answerYesNo(q2, true), answerYesNo(q3, true)];
    const body = clientBody(survey.questions, answers);
    const evaluation = evaluateSubmission(survey, body);
    expect(evaluation.hidden, "hiddenDropped").toEqual([]);
    expect(evaluation.answers.map((a) => a.questionId)).toEqual(body.map((a) => a.questionId));
    // экран Q3 не показывал — и тревоги нет: показанное и посчитанное совпадают
    expect(evaluation.risk.severity).toBeNull();
  });

  test("countedAnswers и computeProfile по полному набору ответов тоже не видят Q3", () => {
    const { q1, q2, q3, survey } = chain();
    const answers = [answerYesNo(q1, false), answerYesNo(q2, true), answerYesNo(q3, true)];
    const counted = countedAnswers(survey, answers);
    expect(counted.answers.map((a) => a.questionId)).toEqual([q1.id]);
    expect(counted.hidden.sort()).toEqual([q2.id, q3.id].sort());
    // скрытый Q3 не задавали: шкала из него одного без единого заданного пункта — ноль, а не 1
    const [score] = computeProfile(survey, answers).scores;
    expect(score!.rawScore).toBe(0);
  });

  test("видимость одна и та же по полному набору ответов и по одним видимым — при любых ответах", () => {
    const { q1, q2, q3, survey } = chain();
    const options = (q: Question) => [undefined, answerYesNo(q, true), answerYesNo(q, false)];
    for (const a1 of options(q1)) {
      for (const a2 of options(q2)) {
        for (const a3 of options(q3)) {
          const answers = [a1, a2, a3].filter((a): a is Answer => !!a);
          const full = survey.questions.map((q) => isQuestionVisible(q, survey.questions, mapOf(answers)));
          const body = clientBody(survey.questions, answers);
          const server = survey.questions.map((q) => isQuestionVisible(q, survey.questions, mapOf(body)));
          expect(server).toEqual(full);
          expect(evaluateSubmission(survey, body).hidden).toEqual([]);
        }
      }
    }
  });

  test("контроль: Q1 «так» — Q2 и Q3 показаны, тяжёлый ответ поднимает риск", () => {
    const { q1, q2, q3, survey } = chain();
    const answers = [answerYesNo(q1, true), answerYesNo(q2, true), answerYesNo(q3, true)];
    const all = mapOf(answers);
    expect(survey.questions.map((q) => isQuestionVisible(q, survey.questions, all))).toEqual([true, true, true]);
    const evaluation = evaluateSubmission(survey, clientBody(survey.questions, answers));
    expect(evaluation.hidden).toEqual([]);
    expect(evaluation.risk.severity).toBe("severe");
    expect(evaluation.profile.scores[0]!.rawScore).toBe(1);
  });

  test("hide-правило со скрытым источником: источник не отвечен, пункт показан", () => {
    const { q1, q2, survey } = chain();
    const q4 = yesNoQuestion(3);
    q4.logic = [{ ...rule(q2, { operator: "answered", action: "hide" }), questionId: q4.id }];
    const questions = [...survey.questions, q4];
    const answers = mapOf([answerYesNo(q1, false), answerYesNo(q2, true)]);
    expect(isQuestionVisible(q4, questions, answers)).toBe(true);
    const shown = mapOf([answerYesNo(q1, true), answerYesNo(q2, true)]);
    expect(isQuestionVisible(q4, questions, shown)).toBe(false);
  });
});
