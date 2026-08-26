import type {
  Answer,
  LogicRule,
  Option,
  Question,
  Scale,
  ScaleBand,
  SurveyFull,
} from "../src/types";

/**
 * Фабрика синтетических методик для тестов движка.
 *
 * Строит SurveyFull в том же виде, в каком его отдаёт attachContent на
 * сервере, но без БД: каждый механизм движка проверяется на минимальной
 * конструкции, где ожидаемый результат можно посчитать в уме.
 */

let seq = 0;
const id = (prefix: string) => `${prefix}-${++seq}`;

export function yesNoQuestion(position: number, over: Partial<Question> = {}): Question {
  const qid = id("q");
  const options: Option[] = [
    { id: `${qid}-yes`, questionId: qid, text: "Да", keyCode: "yes", score: 1, kind: "option", position: 0, riskFlag: false, riskSeverity: null, riskLabel: null },
    { id: `${qid}-no`, questionId: qid, text: "Нет", keyCode: "no", score: 0, kind: "option", position: 1, riskFlag: false, riskSeverity: null, riskLabel: null },
  ];
  return {
    id: qid,
    surveyId: "s",
    sectionId: null,
    type: "yesno",
    title: `Пункт ${position + 1}`,
    help: null,
    required: true,
    position,
    scaleId: null,
    reverseScored: false,
    minValue: null,
    maxValue: null,
    step: null,
    minLabel: null,
    maxLabel: null,
    randomizeOptions: false,
    timeLimitSec: null,
    riskThreshold: null,
    riskLabel: null,
    riskSeverity: null,
    options,
    logic: [],
    ...over,
  };
}

/** Вопрос с числовой шкалой 0..max */
export function scaleQuestion(position: number, max: number, over: Partial<Question> = {}): Question {
  return {
    ...yesNoQuestion(position),
    type: "scale",
    minValue: 0,
    maxValue: max,
    step: 1,
    options: [],
    ...over,
  };
}

export function makeScale(over: Partial<Scale> & Pick<Scale, "code">): Scale {
  return {
    id: id("sc"),
    surveyId: "s",
    title: over.code,
    description: null,
    aggregation: "sum",
    position: 0,
    kind: "clinical",
    normalization: "raw",
    ratioDenominator: null,
    validityThreshold: null,
    validityDirection: null,
    validityMessage: null,
    bands: [],
    items: [],
    corrections: [],
    norms: [],
    stenTable: [],
    ...over,
  };
}

export function band(scaleId: string, min: number, max: number, label: string, over: Partial<ScaleBand> = {}): ScaleBand {
  return {
    id: id("b"),
    scaleId,
    minScore: min,
    maxScore: max,
    label,
    severity: "none",
    description: null,
    grade: null,
    recommendation: null,
    ...over,
  };
}

export function makeSurvey(questions: Question[], scales: Scale[]): SurveyFull {
  return {
    id: "s",
    groupId: null,
    title: "Тестовая методика",
    description: null,
    instructions: null,
    administration: "self",
    tooFastMs: null,
    alertEscalateMinutes: null,
    status: "published",
    visibility: "public",
    anonymous: false,
    allowRetake: true,
    allowBack: true,
    showProgress: true,
    randomizeQuestions: false,
    timeLimitSec: null,
    scoringEnabled: true,
    createdBy: "tester",
    createdAt: "2026-01-01",
    publishedAt: "2026-01-01",
    currentVersionId: "v1",
    sections: [],
    questions,
    scales,
    versionId: "v1",
    versionNumber: 1,
  } as unknown as SurveyFull;
}

/** Ответ «Да»/«Нет» на yes/no-вопрос */
export function answerYesNo(question: Question, yes: boolean): Answer {
  const key = yes ? "yes" : "no";
  const option = question.options.find((o) => o.keyCode === key)!;
  return { questionId: question.id, optionIds: [option.id] };
}

export function answerNumber(question: Question, value: number): Answer {
  return { questionId: question.id, number: value };
}

export function rule(source: Question, over: Partial<LogicRule> = {}): LogicRule {
  return {
    id: id("r"),
    questionId: "target",
    sourceQuestionId: source.id,
    operator: "answered",
    value: null,
    action: "show",
    ...over,
  } as LogicRule;
}
