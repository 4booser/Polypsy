import type { Answer, Option, Question, RiskSeverity, SurveyFull } from "../src/types";
import { band, makeScale, makeSurvey, rule, scaleQuestion, yesNoQuestion } from "./fixtures";

/**
 * Набор случаев риска — один на все места, где риск решается.
 *
 * Прогоняется и по общему движку (packages/shared/test/risk.test.ts), и по
 * офлайн-памятке веб-кабинета (apps/web/test/offlineRisk.test.ts): «клиент
 * без сети и сервер решают одинаково» проверяется на одних и тех же
 * методиках и ответах, а не на похожих. Каждый случай — то, что до волны 12
 * клиент решал иначе, чем сервер.
 */
export interface RiskCase {
  name: string;
  survey: SurveyFull;
  answers: Answer[];
  /** Итоговая тяжесть сдачи; null — риска нет, карточка не показывается */
  expected: RiskSeverity | null;
}

function riskyOption(question: Question, index: number, severity: RiskSeverity | null): Question {
  return {
    ...question,
    options: question.options.map((o, i) =>
      i === index ? { ...o, riskFlag: true, riskLabel: "критично", riskSeverity: severity } : o,
    ),
  };
}

function matrixQuestion(position: number): Question {
  const base = yesNoQuestion(position);
  const qid = base.id;
  const opt = (id: string, kind: "row" | "option", text: string, score: number, pos: number): Option => ({
    id: `${qid}-${id}`,
    questionId: qid,
    text,
    keyCode: null,
    score,
    kind,
    position: pos,
    riskFlag: false,
    riskLabel: null,
    riskSeverity: null,
  });
  return {
    ...base,
    type: "matrix",
    options: [
      opt("r1", "row", "Сон", 0, 0),
      opt("r2", "row", "Думки про смерть", 0, 1),
      opt("never", "option", "Ніколи", 0, 2),
      { ...opt("daily", "option", "Щодня", 3, 3), riskFlag: true, riskLabel: "щодня", riskSeverity: "severe" },
    ],
  };
}

export function riskCases(): RiskCase[] {
  const cases: RiskCase[] = [];

  /* флаг варианта — то, что клиенты умели и раньше */
  {
    const q = riskyOption(yesNoQuestion(0), 0, "moderate");
    const survey = makeSurvey([q], []);
    cases.push({ name: "флаг варианта", survey, answers: [{ questionId: q.id, optionIds: [q.options[0]!.id] }], expected: "moderate" });
    cases.push({ name: "флаг не выбран", survey, answers: [{ questionId: q.id, optionIds: [q.options[1]!.id] }], expected: null });
  }

  /* числовой порог: клиенты его не проверяли */
  {
    const q = scaleQuestion(0, 10, { riskThreshold: 7, riskLabel: "високий бал", riskSeverity: "severe" });
    const survey = makeSurvey([q], []);
    cases.push({ name: "числовой порог достигнут", survey, answers: [{ questionId: q.id, number: 7 }], expected: "severe" });
    cases.push({ name: "числовой порог не достигнут", survey, answers: [{ questionId: q.id, number: 6 }], expected: null });
  }

  /* критический столбец матрицы: клиенты смотрели только optionIds */
  {
    const q = matrixQuestion(0);
    const survey = makeSurvey([q], []);
    cases.push({
      name: "критический столбец матрицы",
      survey,
      answers: [{ questionId: q.id, matrix: { [`${q.id}-r1`]: `${q.id}-never`, [`${q.id}-r2`]: `${q.id}-daily` } }],
      expected: "severe",
    });
  }

  /* тяжёлая полоса содержательной шкалы без единого критического ответа */
  {
    const q = scaleQuestion(0, 10);
    const scale = makeScale({ code: "D", items: [{ questionId: q.id, matchKey: null, weight: 1 }] });
    scale.bands = [band(scale.id, 0, 4, "Норма"), band(scale.id, 5, 10, "Тяжкий", { severity: "severe" })];
    const survey = makeSurvey([q], [scale]);
    cases.push({ name: "тяжёлая полоса шкалы", survey, answers: [{ questionId: q.id, number: 8 }], expected: "severe" });
    cases.push({ name: "полоса нормы", survey, answers: [{ questionId: q.id, number: 2 }], expected: null });

    /* подсчёт выключен — полос нет, но критический ответ проверяется всё равно */
    const flagged = riskyOption(yesNoQuestion(1), 0, "severe");
    const off = { ...makeSurvey([q, flagged], [scale]), scoringEnabled: false } as SurveyFull;
    cases.push({ name: "подсчёт выключен: полосы нет", survey: off, answers: [{ questionId: q.id, number: 8 }], expected: null });
    cases.push({
      name: "подсчёт выключен: флаг проверяется",
      survey: off,
      answers: [{ questionId: flagged.id, optionIds: [flagged.options[0]!.id] }],
      expected: "severe",
    });
  }

  /* полоса шкалы достоверности — не риск */
  {
    const q = scaleQuestion(0, 10);
    const scale = makeScale({ code: "L", kind: "validity", items: [{ questionId: q.id, matchKey: null, weight: 1 }] });
    scale.bands = [band(scale.id, 5, 10, "Сумнівно", { severity: "severe" })];
    const survey = makeSurvey([q], [scale]);
    cases.push({ name: "полоса шкалы достоверности", survey, answers: [{ questionId: q.id, number: 9 }], expected: null });
  }

  /* критический ответ на скрытый условием пункт — не риск */
  {
    const gate = yesNoQuestion(0);
    const hidden = riskyOption(yesNoQuestion(1, { logic: [rule(gate, { operator: "gte", value: 1 })] }), 0, "severe");
    const survey = makeSurvey([gate, hidden], []);
    const no = gate.options.find((o) => o.keyCode === "no")!.id;
    const yes = gate.options.find((o) => o.keyCode === "yes")!.id;
    cases.push({
      name: "скрытый пункт",
      survey,
      answers: [
        { questionId: gate.id, optionIds: [no] },
        { questionId: hidden.id, optionIds: [hidden.options[0]!.id] },
      ],
      expected: null,
    });
    cases.push({
      name: "тот же пункт открыт",
      survey,
      answers: [
        { questionId: gate.id, optionIds: [yes] },
        { questionId: hidden.id, optionIds: [hidden.options[0]!.id] },
      ],
      expected: "severe",
    });
  }

  /* флаг и полоса вместе: итог — худший */
  {
    const q = scaleQuestion(0, 10);
    const flagged = riskyOption(yesNoQuestion(1), 0, "moderate");
    const scale = makeScale({ code: "D", items: [{ questionId: q.id, matchKey: null, weight: 1 }] });
    scale.bands = [band(scale.id, 5, 10, "Тяжкий", { severity: "severe" })];
    const survey = makeSurvey([q, flagged], [scale]);
    cases.push({
      name: "умеренный флаг и тяжёлая полоса",
      survey,
      answers: [
        { questionId: q.id, number: 9 },
        { questionId: flagged.id, optionIds: [flagged.options[0]!.id] },
      ],
      expected: "severe",
    });
  }

  return cases;
}
