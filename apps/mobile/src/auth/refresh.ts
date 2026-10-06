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
 */

export type RefreshOutcome =
  | { kind: "refreshed" }
  | { kind: "invalid" }
  | { kind: "unavailable"; status: number };

export interface RefreshPair {
  token: string;
  refreshToken: string;
}

export interface RefreshDeps {
  /** Текущий refresh из защищённого хранилища; null — не вошли или вышли */
  getRefresh(): Promise<string | null>;
  /** Сам обмен; бросает при обрыве сети */
  exchange(refreshToken: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  /** Записать новую пару */
  save(pair: RefreshPair): Promise<void>;
}

async function once(deps: RefreshDeps): Promise<RefreshOutcome> {
  let raw: string | null;
  try {
    raw = await deps.getRefresh();
  } catch {
    // хранилище не ответило — это не «сессии нет», а «сейчас не узнать»
    return { kind: "unavailable", status: 0 };
  }
  if (!raw) return { kind: "invalid" };

  let res: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    res = await deps.exchange(raw);
  } catch {
    return { kind: "unavailable", status: 0 };
  }
  if (!res.ok) {
    // 4xx — сервер посмотрел на токен и отверг его; 5xx — не посмотрел
    return res.status >= 400 && res.status < 500 ? { kind: "invalid" } : { kind: "unavailable", status: res.status };
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
    if ((await deps.getRefresh()) !== raw) return { kind: "invalid" };
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
  return () => {
    shared ??= once(deps).finally(() => {
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
