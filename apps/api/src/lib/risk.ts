import type { Answer, Question, RiskSeverity, SurveyFull } from "@quizzy/shared";

export interface DetectedRisk {
  questionId: string;
  label: string;
  severity: RiskSeverity;
}

/**
 * Ищет критические пункты в текущих ответах.
 *
 * Вызывается и при отправке, и при автосохранении черновика: если человек
 * отметил пункт про суицидальные мысли на третьем вопросе из сорока,
 * персонал должен узнать об этом сразу, а не через двадцать минут.
 */
export function detectRisks(survey: SurveyFull, answers: Answer[]): DetectedRisk[] {
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const found: DetectedRisk[] = [];

  for (const question of survey.questions) {
    const answer = byQuestion.get(question.id);
    if (!answer || answer.skipped) continue;

    const risk = riskOf(question, answer);
    if (risk) found.push({ questionId: question.id, ...risk });
  }
  return found;
}

function riskOf(
  question: Question,
  answer: Answer,
): { label: string; severity: RiskSeverity } | null {
  /*
   * Выбранный вариант помечен как критический — берём САМЫЙ ТЯЖЁЛЫЙ из
   * отмеченных, а не первый попавшийся.
   *
   * Прежний цикл выходил на первом совпадении, то есть на том варианте,
   * который стоит раньше по порядку. В вопросе с выбором нескольких —
   * «мысли о смерти» (умеренная) и «план ухода из жизни» (тяжёлая) —
   * человек, отметивший оба, поднимал тревогу как умеренную. Случай
   * открывался умеренным, и в очереди разбора оказывался ниже.
   */
  const picked = new Set([...(answer.optionIds ?? []), ...Object.values(answer.matrix ?? {})]);
  const weight: Record<RiskSeverity, number> = { moderate: 1, severe: 2 };
  let worst: { label: string; severity: RiskSeverity } | null = null;
  for (const option of question.options) {
    if (!option.riskFlag || !picked.has(option.id)) continue;
    const found = {
      label: option.riskLabel ?? `${question.title} — ${option.text}`,
      severity: option.riskSeverity ?? ("severe" as RiskSeverity),
    };
    if (!worst || weight[found.severity] > weight[worst.severity]) worst = found;
  }
  if (worst) return worst;

  // числовой ответ достиг порога
  if (question.riskThreshold !== null && typeof answer.number === "number") {
    if (answer.number >= question.riskThreshold) {
      return {
        label: question.riskLabel ?? `${question.title}: ${answer.number}`,
        severity: question.riskSeverity ?? "severe",
      };
    }
  }

  return null;
}
