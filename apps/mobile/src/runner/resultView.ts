/**
 * Что показать на экране после сдачи.
 *
 * Флаг методики showResultsToPatient решает, видит ли пациент свои баллы.
 * У PHQ-9, PCL-5, PQ-16 и ещё полутора десятков он снят сознательно (см.
 * apps/api/src/instruments/*): балл без толкования специалиста человек
 * прочтёт как диагноз. Мобилка флаг не читала — показывала баллы, полосы и
 * описания полос и при онлайн-сдаче (их вернул сервер), и офлайн (посчитала
 * сама), да ещё и кнопку «Відкрити висновок». Сервер со своей стороны чинит
 * участок engine; здесь — чтобы экран не показал того, что пришло или
 * посчиталось.
 *
 * Правило:
 *   за пациента заполняет специалист (обход, onBehalfOf) — всё видно: у
 *     телефона клиницист, результат для него;
 *   проходит сам человек — баллы и «висновок» только при снятом запрете;
 *   карточка плана безопасности при риске видна ВСЕГДА: это не результат,
 *     а помощь, и прятать её за флагом нельзя.
 *
 * «Висновок» для сдачи, лёгшей в офлайн-очередь, не предлагается никому:
 * её id — номер в очереди, а не прохождение на сервере, и ссылка вела бы в
 * пустоту.
 *
 * Без react-native — проверяется тестом.
 */
export interface ResultInput {
  showResultsToPatient: boolean;
  scoringEnabled: boolean;
  /** Заполняет специалист за пациента */
  onBehalfOf: boolean;
  queued: boolean;
  scoresCount: number;
  responseId: string | null;
  safetyPlan: string | null;
}

export interface ResultView {
  /** Карточка баллов: шкалы, полосы, описания */
  scores: boolean;
  /** Кнопка «Відкрити висновок» */
  conclusion: boolean;
  /** Строка «бали тлумачить фахівець» — вместо баллов, а не рядом с ними */
  hiddenNote: boolean;
  /** Строка про время и сохранение: у офлайн-сдачи — с упоминанием баллов или без */
  tookKey: "msv.tookSaved" | "msv.tookQueued" | "msv.tookQueuedNoScores";
  /** План безопасности при риске — без условий */
  safetyPlan: string | null;
}

export function resultView(input: ResultInput): ResultView {
  const allowed = input.onBehalfOf || input.showResultsToPatient;
  const scores = allowed && input.scoresCount > 0;
  return {
    scores,
    conclusion: allowed && !input.queued && !!input.responseId,
    hiddenNote: !allowed && input.scoringEnabled,
    tookKey: input.queued ? (scores ? "msv.tookQueued" : "msv.tookQueuedNoScores") : "msv.tookSaved",
    safetyPlan: input.safetyPlan,
  };
}
