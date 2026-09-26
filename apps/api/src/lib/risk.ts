import { detectAnswerRisks, type Answer, type AnswerRisk, type SurveyFull } from "@quizzy/shared";

export type DetectedRisk = AnswerRisk;

/**
 * Ищет критические пункты в текущих ответах.
 *
 * Вызывается при автосохранении черновика: если человек отметил пункт про
 * суицидальные мысли на третьем вопросе из сорока, персонал должен узнать
 * об этом сразу, а не через двадцать минут.
 *
 * Сам поиск живёт в общем пакете (packages/shared/src/risk.ts) — тем же
 * кодом риск ищут клиенты без сети. Сдача оценивается там же целиком,
 * вместе с полосами шкал и отбором видимых ответов (evaluateSubmission);
 * здесь — только кирпич для черновика, где подсчёта ещё нет.
 */
export function detectRisks(survey: Pick<SurveyFull, "questions">, answers: Answer[]): DetectedRisk[] {
  return detectAnswerRisks(survey, answers);
}
