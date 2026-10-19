import type { RefreshOutcome } from "./refresh";

/**
 * Сессия кончилась насовсем — тот же путь, что выход.
 *
 * Было: истёкшая или отозванная сессия на телефоне не кончалась ничем.
 * Запросы падали с 401, а человек оставался «вошедшим»: экраны держали
 * пациентов, на диске лежали обход, карты у койки, план безопасности и
 * черновики разбора. На общем планшете отделения следующий брал в руки
 * чужие данные — выход их уносит, а сессию, которая кончилась сама, не
 * уносило ничего.
 *
 * Кончилась — это только слово сервера (auth/refresh.ts, InvalidReason):
 * он ответил 401 на обмен refresh (отозван, истёк, учётку выключили), или
 * продлевать нечем — refresh на устройстве нет, а сервер уже не принял
 * access. Сети нет, сервер лежит, прочий отказ — сессия жива: медсестра в
 * подвале без связи по-прежнему читает обход и карты под замком приложения.
 *
 * Тогда — как при выходе (offline/logout.ts, leaveDevice): копии с сервера
 * уходят, запись за вышедшего закрыта, черновики разбора стёрты; очередь
 * сдач и неотправленные черновики остаются за ним и уйдут после его входа.
 * Токены снимаются, приложение уходит на вход и говорит, почему.
 *
 * Без react-native — проверяется тестом.
 */

/** Кончилась ли сессия по исходу продления */
export function endsSession(outcome: RefreshOutcome): boolean {
  return outcome.kind === "invalid" && (outcome.reason === "rejected" || outcome.reason === "none");
}

export interface SessionEndDeps {
  /** Токен в хранилище сейчас */
  token: () => Promise<string | null>;
  ownerOf: (token: string | null) => string | null;
  /** Офлайн-слой вышедшего — как при выходе (offline/logout.ts, leaveDevice) */
  leave: (owner: string) => void;
  clearTokens: () => Promise<void>;
}

export interface SessionEnder {
  /**
   * Закончить сессию, токен которой ушёл в отвергнутом запросе.
   *
   * Сверяется сам токен, а не только владелец: пока шёл обмен, могли выйти,
   * мог войти другой — или тот же человек вошёл заново (смена пароля гасит
   * все сессии и тут же входит новым паролем). Токен в хранилище уже не тот —
   * ничего не делает: эту, новую сессию отказ не касается. true — сессия
   * закончена этим вызовом.
   */
  end: (token: string | null) => Promise<boolean>;
  /** Подписка: интерфейс снимает пользователя и уходит на вход; возвращает отписку */
  onEnded: (listener: () => void) => () => void;
  /** Экран входа: была ли сессия закончена с прошлого показа (и забыть об этом) */
  takeNotice: () => boolean;
}

export function createSessionEnder(deps: SessionEndDeps): SessionEnder {
  const listeners = new Set<() => void>();
  let notice = false;
  /* одновременные 401 одного обмена заканчивают сессию один раз */
  const ending = new Map<string, Promise<boolean>>();

  const run = async (token: string): Promise<boolean> => {
    if ((await deps.token().catch(() => null)) !== token) return false;
    const owner = deps.ownerOf(token);
    if (owner) deps.leave(owner);
    try {
      await deps.clearTokens();
    } catch {
      /* не снялись — следующий запуск получит тот же отказ и снимет; данные уже ушли */
    }
    notice = true;
    for (const listener of listeners) listener();
    return true;
  };

  return {
    end: (token) => {
      if (!token) return Promise.resolve(false);
      let pending = ending.get(token);
      if (!pending) {
        pending = run(token).finally(() => {
          ending.delete(token);
        });
        ending.set(token, pending);
      }
      return pending;
    },
    onEnded: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    takeNotice: () => {
      const was = notice;
      notice = false;
      return was;
    },
  };
}
