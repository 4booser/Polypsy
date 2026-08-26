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
  // выбранный вариант помечен как критический
  const picked = new Set([...(answer.optionIds ?? []), ...Object.values(answer.matrix ?? {})]);
  for (const option of question.options) {
    if (!option.riskFlag || !picked.has(option.id)) continue;
    return {
      label: option.riskLabel ?? `${question.title} — ${option.text}`,
      severity: option.riskSeverity ?? "severe",
    };
  }

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
