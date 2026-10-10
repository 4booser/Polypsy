import { isQuestionVisible, type Answer, type SurveyFull } from "@quizzy/shared";
import { api, type Patient } from "../api";

/**
 * Ввод методики специалистом (Administer.tsx): какая версия и что уходит.
 *
 * Бумажный бланк печатают пачкой заранее, и его код ведёт сюда с номером
 * версии — `…/administer?v=N` (BlankForm.tsx, SheetCode). Экран номер не
 * читал (#169): грузилась и сдавалась действующая версия. Методику правили
 * после печати — ответы бланка vN ложились на пункты v(N+1) и считались по
 * её ключу, а быстрый ввод по порядку переносил их на чужие пункты молча.
 */

/** Номер версии из `?v=` — целое от единицы; нет или мусор — действующая версия */
export function blankVersion(raw: string | null): number | undefined {
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n >= 1 ? n : undefined;
}

/**
 * Методика той версии, что на бланке, и список пациентов. Версии нет —
 * отказ сервера (err.surveyVersionNotFound) показывается как ошибка
 * загрузки, а не подменяется действующей.
 */
export async function loadAdminister(
  id: string,
  version: number | undefined,
): Promise<{ survey: SurveyFull; patients: Patient[] }> {
  const [survey, patients] = await Promise.all([api.survey(id, version), api.patients().then((p) => p.items)]);
  return { survey, patients };
}

/** Тело сдачи за пациента */
export function administerPayload(
  survey: SurveyFull,
  input: { subject: string; startedAt: string; answers: Map<string, Answer>; now?: number },
) {
  const visible = survey.questions.filter((q) => isQuestionVisible(q, survey.questions, input.answers));
  return {
    onBehalfOf: input.subject,
    // считается по той версии, пункты которой на экране (с бланка — его версия), а не по действующей на момент нажатия
    versionId: survey.versionId,
    startedAt: input.startedAt,
    durationMs: (input.now ?? Date.now()) - new Date(input.startedAt).getTime(),
    status: "completed" as const,
    events: [],
    /*
     * Только ответы на показанные пункты. Движок считает всё, что пришло,
     * а ответ на пункт, скрытый условием, остаётся в памяти формы: в ASSIST
     * специалист отметил «да» по веществу, заполнил частоту, потом исправил
     * «да» на «нет» — и балл по веществу, которого человек не употреблял,
     * ушёл бы в протокол. Пациентская форма (Runner) шлёт так же — только
     * видимые. Отвергнуто чистить ответы при смене условия: скрытый пункт
     * вернётся с прежним ответом, если специалист передумает обратно.
     */
    answers: [...input.answers.values()].filter((a) => visible.some((q) => q.id === a.questionId)),
  };
}
