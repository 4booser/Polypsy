import { drafts, type LocalDraft, type ResumableDraft } from "../offline/cache";
import { draftLaneKey, draftLanes } from "../offline/draftLane";

/**
 * Черновик есть только у своего прохождения (#127).
 *
 * Черновик — и на сервере, и на устройстве — того, кто вошёл: сервер ищет его
 * по токену, устройство — по владельцу. За пациента (режим обхода,
 * onBehalfOf) заполняет специалист, и его черновик к пациенту отношения не
 * имеет. Экран же читал его и тут: предлагал «Продовжити» с ответами
 * специалиста, «Завершити» отправлял их на пациента, а после сдачи стирал
 * локальную копию специалиста — серверная при этом переживала сдачу и
 * подставлялась следующему пациенту.
 *
 * За пациента черновик не читается ни с сервера, ни с устройства
 * (прохождение начинается заново, со своим startedAt), не пишется
 * (автосохранение, app/survey/[id].tsx) и не стирается после сдачи.
 *
 * Без react-native: оба решения проверяются тестом (test/onBehalf.test.ts).
 */

export interface Who {
  /** Владелец сессии — чей черновик лежит на устройстве */
  owner: string | null;
  /** За кого заполняют; задан — прохождение не своё */
  onBehalfOf?: string | null;
}

/** Черновики, из которых выбирают продолжение (offline/cache.ts, pickDraft) */
export async function draftsToResume(
  surveyId: string,
  who: Who,
  remote: (surveyId: string) => Promise<ResumableDraft | null>,
): Promise<{ local: LocalDraft | null; remote: ResumableDraft | null }> {
  if (who.onBehalfOf) return { local: null, remote: null };
  const fromServer = await remote(surveyId).catch(() => null);
  return { local: drafts.get(who.owner, surveyId), remote: fromServer };
}

/** Прохождение сдано: свой черновик больше не нужен, чужого — не трогаем */
export function dropOwnDraft(surveyId: string, who: Who): void {
  if (who.onBehalfOf || !who.owner) return;
  // ждущее сохранение, дойдя до сервера после сдачи, завело бы там новое «незавершённое»
  draftLanes.cancelPending(draftLaneKey(who.owner, surveyId));
  drafts.drop(who.owner, surveyId);
}
