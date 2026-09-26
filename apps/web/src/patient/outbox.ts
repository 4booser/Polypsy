import { isTransientStatus } from "@quizzy/shared";

/**
 * Несданные ответы веб-кабинета — ждут конца работ или появления сети.
 *
 * До режима обслуживания у веб-кабинета очереди не было вовсе: отказ сдачи
 * показывался всплывашкой, ответы жили в состоянии экрана, и закрытая
 * вкладка теряла их целиком. С режимом обслуживания это стало не редкостью,
 * а расписанием: на время работ сервер отвечает 503 на каждую сдачу.
 * Ответы — клинические данные, и потерять их из-за объявленных работ
 * нельзя.
 *
 * Устроено как очередь мобилки (apps/mobile/src/offline/queue.ts), и по тем
 * же правилам:
 *
 * - порядок сдачи сохраняется, отправка — по одной;
 * - временный отказ (нет сети, 502/503/504 — isTransientStatus)
 *   останавливает проход, следующая попытка начнёт с того же места;
 * - отказ по существу (4xx, 500) помечает запись и не блокирует остальных:
 *   битую сдачу нельзя ни потерять молча, ни повторять вечно;
 * - у каждой сдачи clientRequestId с ПЕРВОЙ попытки, и сервер узнаёт
 *   дубль, если первая попытка всё же успела записаться (504 от прокси
 *   приходит и тогда, когда приложение своё сделало).
 *
 * Хранится в localStorage, отдельной записью на человека. Не общей: за
 * одним компьютером входят разные люди, и чужая сдача не должна уйти под
 * чужим входом — очередь другого человека просто не читается. При выходе
 * она НЕ стирается: стереть — значит потерять ответы, которых больше нигде
 * нет; уходит она при следующем входе того же человека. Цена названа:
 * ответы лежат в браузере открытыми до отправки — ровно как черновик в
 * мобилке. Отправленное удаляется сразу.
 */

export interface OutboxItem {
  id: string;
  surveyId: string;
  payload: Record<string, unknown> & { clientRequestId: string };
  queuedAt: string;
  attempts: number;
  /** Отказ по существу: ждёт решения человека, сам не уходит */
  rejectedReason?: string;
}

export type OutboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export interface FlushResult {
  sent: number;
  left: number;
  rejected: number;
}

const keyOf = (userId: string) => `quizzy.outbox.${userId}`;

export function createOutbox(storage: OutboxStorage) {
  function read(userId: string): OutboxItem[] {
    try {
      const raw = storage.getItem(keyOf(userId));
      return raw ? (JSON.parse(raw) as OutboxItem[]) : [];
    } catch {
      return [];
    }
  }

  function write(userId: string, items: OutboxItem[]) {
    if (items.length) storage.setItem(keyOf(userId), JSON.stringify(items));
    else storage.removeItem(keyOf(userId));
  }

  let flushing = false;

  return {
    /** Положить сдачу ждать. Бросает, если хранилище недоступно: тогда ответы остаются на экране */
    enqueue(userId: string, surveyId: string, payload: Record<string, unknown>): OutboxItem {
      const clientRequestId =
        typeof payload.clientRequestId === "string" ? payload.clientRequestId : crypto.randomUUID();
      const item: OutboxItem = {
        id: crypto.randomUUID(),
        surveyId,
        payload: { ...payload, clientRequestId },
        queuedAt: new Date().toISOString(),
        attempts: 0,
      };
      write(userId, [...read(userId), item]);
      return item;
    },

    waiting(userId: string): OutboxItem[] {
      return read(userId).filter((i) => !i.rejectedReason);
    },

    rejected(userId: string): OutboxItem[] {
      return read(userId).filter((i) => !!i.rejectedReason);
    },

    /** Отправить ждущие по порядку; submit бросает ошибку со `status` */
    async flush(userId: string, submit: (item: OutboxItem) => Promise<unknown>): Promise<FlushResult> {
      const count = (): FlushResult => {
        const all = read(userId);
        return { sent: 0, left: all.filter((i) => !i.rejectedReason).length, rejected: all.filter((i) => !!i.rejectedReason).length };
      };
      if (flushing) return count();
      flushing = true;
      let sent = 0;
      try {
        for (const item of read(userId)) {
          if (item.rejectedReason) continue;
          try {
            await submit(item);
            write(userId, read(userId).filter((i) => i.id !== item.id));
            sent++;
          } catch (error) {
            const status = (error as { status?: number }).status ?? 0;
            if (isTransientStatus(status)) break;
            write(
              userId,
              read(userId).map((i) =>
                i.id === item.id
                  ? {
                      ...i,
                      attempts: i.attempts + 1,
                      rejectedReason: error instanceof Error ? error.message : String(status),
                    }
                  : i,
              ),
            );
          }
        }
      } finally {
        flushing = false;
      }
      return { ...count(), sent };
    },

    /** Вернуть отклонённую сдачу в очередь — решение человека, а не кода */
    retry(userId: string, id: string): void {
      write(
        userId,
        read(userId).map((i) => {
          if (i.id !== id) return i;
          const { rejectedReason: _dropped, ...rest } = i;
          return rest;
        }),
      );
    },
  };
}

/** Память вместо хранилища: закрытое хранилище (приватный режим) не должно ронять кабинет */
function memoryStorage(): OutboxStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function browserStorage(): OutboxStorage {
  try {
    return typeof localStorage === "undefined" ? memoryStorage() : localStorage;
  } catch {
    return memoryStorage();
  }
}

export const outbox = createOutbox(browserStorage());

/**
 * Памятка при сдаче, ушедшей в очередь: план безопасности показывается так
 * же, как после обычной сдачи с отмеченным критическим вариантом.
 *
 * Сервер решил бы то же самое по тем же вариантам (riskFlag), просто позже;
 * а человеку, отметившему критический пункт во время работ, памятка нужна
 * сейчас, а не после них. Так делает и мобилка без сети.
 */
export function offlineSafetyPlan(
  survey: { safetyPlan: string | null; questions: { options: { id: string; riskFlag: boolean }[] }[] },
  answers: { optionIds?: string[] }[],
): string | null {
  if (!survey.safetyPlan) return null;
  const risky = new Set(survey.questions.flatMap((q) => q.options.filter((o) => o.riskFlag).map((o) => o.id)));
  return answers.some((a) => (a.optionIds ?? []).some((id) => risky.has(id))) ? survey.safetyPlan : null;
}
