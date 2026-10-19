/**
 * Продление сессии по refresh-токену — без react-native и без клиента
 * запросов, чтобы проверяться тестом (как auth/session.ts).
 *
 * Два дефекта из ревью (CR-020, CR-021), оба — в одном коротком обмене:
 *
 * 1. Общий promise не сбрасывался на раннем выходе «refresh нет». Он нужен,
 *    чтобы несколько запросов, получивших 401 разом, не жгли одноразовый
 *    refresh параллельно, — но сбрасывался только в finally, а `return false`
 *    при пустом хранилище стоял до try. Один 401 от старого запроса после
 *    выхода — и до перезапуска приложения продление возвращало старый
 *    отказ, не трогая сеть, хотя человек давно вошёл снова.
 *
 * 2. Обрыв сети на обмене и недействительный refresh сводились к одному
 *    false. Запрос отдавал исходный 401, очередь несданных считала его
 *    отказом по существу и ставила rejectedReason: сдача выпадала из
 *    автоматического повтора, хотя сессия продлилась бы при первой связи.
 *
 * Поэтому исход — не булево, а три разных ответа: сессия продлена; сессия
 * недействительна (refresh нет, сервер его не принял, человек вышел пока шёл
 * обмен); продлить не удалось по временной причине (сети нет, сервер лежит,
 * хранилище не прочиталось) — и статус, по которому очередь решает, ждать
 * ли (isTransientStatus).
 *
 * Третий дефект (#144): обрыв ПОСЛЕ того, как сервер обмен зафиксировал
 * (502/504 прокси, сеть пропала на ответе). У приложения остался прежний
 * refresh, сервер его уже повернул, и повтор читался как кража: семья гасла,
 * человека выкидывало на вход, сдачи из очереди уходили в отклонённые.
 * Теперь у обмена есть ключ попытки (requestId): он живёт в памяти, пока
 * обмен этого refresh не кончился ответом сервера, и повтор идёт с ним же —
 * сервер узнаёт свой потерянный ответ и отдаёт ту же пару (lib/refresh.ts,
 * RETRY_WINDOW_MS). Ключ не хранится: вор, скопировавший refresh, его не
 * знает, и его предъявление по-прежнему гасит семью.
 */

export type RefreshOutcome =
  | { kind: "refreshed" }
  | { kind: "invalid"; reason: InvalidReason }
  | { kind: "unavailable"; status: number };

/**
 * Почему продлить нельзя — от этого зависит, кончилась ли сессия (auth/sessionEnd.ts).
 *
 *  — rejected: сервер ответил на обмен 401 — refresh отозван, истёк, учётку
 *    выключили. Это его слово, а не сбой: сессия кончилась насовсем;
 *  — none: refresh на устройстве нет — продлевать нечем;
 *  — superseded: refresh сменился, пока шёл обмен (вышли или вошёл другой) —
 *    о сессии того, кто сейчас в приложении, это ничего не говорит;
 *  — refused: прочий 4xx (429 лимита, 400, 403 прокси) — отказ, но не «сессия
 *    кончилась»: стирать по нему офлайн-копии нельзя.
 */
export type InvalidReason = "rejected" | "none" | "superseded" | "refused";

export interface RefreshPair {
  token: string;
  refreshToken: string;
}

export interface RefreshDeps {
  /** Текущий refresh из защищённого хранилища; null — не вошли или вышли */
  getRefresh(): Promise<string | null>;
  /** Сам обмен; бросает при обрыве сети. requestId — ключ попытки: повтор того же обмена несёт тот же */
  exchange(
    refreshToken: string,
    requestId: string,
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Записать новую пару */
  save(pair: RefreshPair): Promise<void>;
}

/**
 * Ключ попытки обмена для этого refresh: тот же, пока обмен его не кончился
 * ответом сервера (#144). Новый refresh — новый ключ.
 */
interface Attempt {
  raw: string;
  requestId: string;
}

async function once(deps: RefreshDeps, attempt: { current: Attempt | null }): Promise<RefreshOutcome> {
  let raw: string | null;
  try {
    raw = await deps.getRefresh();
  } catch {
    // хранилище не ответило — это не «сессии нет», а «сейчас не узнать»
    return { kind: "unavailable", status: 0 };
  }
  if (!raw) return { kind: "invalid", reason: "none" };

  if (attempt.current?.raw !== raw) attempt.current = { raw, requestId: newRequestId() };
  const outcome = await exchangeOnce(deps, raw, attempt.current.requestId);
  // сервер ответил по существу — попытка кончилась; временный сбой — повтор пойдёт с тем же ключом
  if (outcome.kind !== "unavailable") attempt.current = null;
  return outcome;
}

/** Ключ попытки: 32 шестнадцатеричных знака случайного UUID — сервер ждёт [A-Za-z0-9_-]{16,128} */
function newRequestId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function exchangeOnce(deps: RefreshDeps, raw: string, requestId: string): Promise<RefreshOutcome> {
  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await deps.exchange(raw, requestId);
  } catch {
    return { kind: "unavailable", status: 0 };
  }
  if (!res.ok) {
    // 4xx — сервер посмотрел на токен и отверг его; 5xx — не посмотрел
    if (res.status === 401) return { kind: "invalid", reason: "rejected" };
    return res.status >= 400 && res.status < 500
      ? { kind: "invalid", reason: "refused" }
      : { kind: "unavailable", status: res.status };
  }

  let pair: RefreshPair;
  try {
    pair = (await res.json()) as RefreshPair;
  } catch {
    return { kind: "unavailable", status: 0 };
  }
  if (typeof pair?.token !== "string" || typeof pair.refreshToken !== "string") {
    // ответ «успешный», но пары в нём нет (обрезан прокси) — сессия не судилась, повтор возможен
    return { kind: "unavailable", status: 0 };
  }
  /*
   * Пока шёл обмен, человек мог выйти. Записать новую пару тогда значило
   * бы молча вернуть ему сессию, из которой он только что вышел.
   */
  try {
    if ((await deps.getRefresh()) !== raw) return { kind: "invalid", reason: "superseded" };
    await deps.save(pair);
  } catch {
    return { kind: "unavailable", status: 0 };
  }
  return { kind: "refreshed" };
}

/**
 * Один обмен на все одновременные 401: пока он идёт, остальные ждут его
 * исхода. Сброс общего promise — одним `finally` на весь путь, включая
 * пустое хранилище и исключения, а не в отдельных ветках.
 */
export function createRefresher(deps: RefreshDeps): () => Promise<RefreshOutcome> {
  let shared: Promise<RefreshOutcome> | null = null;
  const attempt: { current: Attempt | null } = { current: null };
  return () => {
    shared ??= once(deps, attempt).finally(() => {
      shared = null;
    });
    return shared;
  };
}

/**
 * Каким статусом запрос падает, если после 401 продлить сессию не удалось.
 *
 * Сессия недействительна — наружу идёт исходный 401: вызывающий (очередь,
 * экран) видит отказ по существу. Продление не состоялось по временной
 * причине — наружу идёт её статус (0 — сети нет, 5xx — сервер лежит), и
 * очередь по isTransientStatus оставляет сдачу в автоматическом повторе:
 * сам запрос сервер не судил.
 */
export function failureStatusAfterRefresh(
  outcome: Exclude<RefreshOutcome, { kind: "refreshed" }>,
  original: number,
): number {
  return outcome.kind === "unavailable" ? outcome.status : original;
}
