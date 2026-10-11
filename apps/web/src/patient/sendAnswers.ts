import { consentViewOf, isTransientStatus, type ConsentStatus } from "@quizzy/shared";
import { api, ApiError } from "../api";
import { acceptFailure } from "./ConsentGate";

/**
 * Сдача прохождения из кабинета — и что с ней бывает, кроме «принято».
 *
 * Вынесено из Runner, чтобы переходы проверялись без браузера
 * (test/runnerConsent.test.ts).
 *
 * Три исхода, кроме отказа по существу (он бросается, и ответы остаются на
 * экране, как раньше):
 *
 * - принято сервером;
 * - отложено на устройстве: временный отказ (нет сети, работы, 502/504 —
 *   isTransientStatus) кладёт сдачу в очередь кабинета (outbox.ts);
 * - ждёт согласия (#171). Новую редакцию согласия опубликовали, пока человек
 *   отвечал: сервер отвечает 403 (routes/responses.ts, assertConsent).
 *   Принять её можно было только на /me — прохождение размонтировалось, и
 *   ответы, жившие лишь в его состоянии, пропадали; в очередь такая сдача не
 *   ложилась. Теперь 403 сверяется со статусом согласия, и, если дело в нём,
 *   сдача держится ЦЕЛИКОМ — тем же телом, с тем же clientRequestId, — пока
 *   человек читает текст на месте. После принятия уходит именно она.
 *
 * Отказ 403 не несёт кода — только переведённый текст, — поэтому причина
 * узнаётся вопросом о статусе, а не разбором фразы. Статус не узнать (нет
 * сети) или согласие в порядке — это другой отказ, и он бросается как есть.
 */

export type SubmitBody = Parameters<typeof api.submitResponse>[1] & { clientRequestId: string };

export interface SendIo {
  submit: (surveyId: string, body: SubmitBody) => Promise<{ safetyPlan: string | null }>;
  consentStatus: () => Promise<ConsentStatus>;
  acceptConsent: (textId: string | null) => Promise<unknown>;
  /** Положить сдачу ждать (outbox.ts); null — некому: никто не вошёл */
  enqueue: ((surveyId: string, body: SubmitBody) => void) | null;
}

/** Сдача, которую держат до принятия согласия: те самые ответы и показанная редакция */
export interface ConsentHold {
  kind: "consent";
  surveyId: string;
  body: SubmitBody;
  status: ConsentStatus;
  /** Почему прошлое «Погоджуюся» не прошло (409 — текст обновился, обрыв связи) */
  error: string | null;
}

export type SendOutcome = { kind: "sent"; safetyPlan: string | null } | { kind: "queued" } | ConsentHold;

export async function sendAnswers(io: SendIo, surveyId: string, body: SubmitBody): Promise<SendOutcome> {
  try {
    const result = await io.submit(surveyId, body);
    return { kind: "sent", safetyPlan: result.safetyPlan ?? null };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (isTransientStatus(error.status) && io.enqueue) {
      io.enqueue(surveyId, body);
      return { kind: "queued" };
    }
    if (error.status === 403) {
      const status = await io.consentStatus().catch(() => null);
      if (status && consentViewOf(status).kind !== "pass") return { kind: "consent", surveyId, body, status, error: null };
    }
    throw error;
  }
}

/**
 * «Погоджуюся» на экране прохождения: принять показанную редакцию и
 * отправить ту же сдачу.
 *
 * Принятие не прошло — сдача остаётся удержанной, с причиной. 409 значит,
 * что редакция сменилась ещё раз, пока человек читал: статус перечитывается,
 * и на экране встаёт новый текст (как в ConsentGate, acceptFailure). Если
 * при этом согласие уже принято (в соседней вкладке), сдача уходит сразу.
 */
export async function acceptAndResend(io: SendIo, hold: ConsentHold, fallbackError: string): Promise<SendOutcome> {
  try {
    await io.acceptConsent(hold.status.textId ?? null);
  } catch (error) {
    const failure = acceptFailure(error, fallbackError);
    const status = failure.reread ? await io.consentStatus().catch(() => hold.status) : hold.status;
    if (consentViewOf(status).kind === "pass") return sendAnswers(io, hold.surveyId, hold.body);
    return { ...hold, status, error: failure.error };
  }
  return sendAnswers(io, hold.surveyId, hold.body);
}

/** Сдача кабинета через клиент API; очередь — того, кто вошёл */
export function cabinetIo(enqueue: SendIo["enqueue"]): SendIo {
  return {
    submit: (surveyId, body) => api.submitResponse(surveyId, body),
    consentStatus: () => api.consentStatus(),
    acceptConsent: (textId) => api.acceptConsent(textId),
    enqueue,
  };
}
