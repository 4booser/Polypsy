import { sql } from "drizzle-orm";
import { db, client } from "../db";
import { log } from "./log";

/**
 * Поток событий приложения.
 *
 * До этого тревога о суицидальном риске ждала, пока кто-нибудь обновит
 * страницу или сработает таймер на минуту. Для этого класса событий такая
 * задержка неприемлема — минута здесь измеряется не удобством.
 *
 * Транспорт — `LISTEN/NOTIFY` PostgreSQL, а не общая память процесса:
 * инстансов API может быть несколько, и подписчик не обязан сидеть на том
 * же, который обработал сдачу. Заодно уведомление отправляется в той же
 * транзакции, что и сама запись: откат отменит и его.
 */

export const CHANNEL = "quizzy_events";

import type { AppEvent } from "@quizzy/shared";

/* договор события — общий с консолью, см. packages/shared/src/types.ts */
export type { AppEvent, AppEventKind } from "@quizzy/shared";

type Handler = (event: AppEvent) => void;

/**
 * Публикация. Вызывается внутри транзакции обработчика: `pg_notify`
 * доставляется только при коммите, поэтому «уведомили, а запись откатилась»
 * невозможно по устройству, а не по внимательности.
 */
export async function publish(
  tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> },
  event: AppEvent,
): Promise<void> {
  try {
    await tx.execute(sql`select pg_notify(${CHANNEL}, ${JSON.stringify(event)})`);
  } catch (error) {
    // поток событий — удобство поверх основного пути; его отказ не должен
    // ронять сдачу прохождения
    log.warn("events.publish_failed", { error: String(error) });
  }
}

/** LISTEN канала: в бою — client.listen postgres.js, в тестах — подмена */
type Listen = (channel: string, onNotify: (payload: string) => void) => Promise<unknown>;

/**
 * Шина процесса: один LISTEN на процесс и сколько угодно подписчиков.
 *
 * Фабрикой, а не состоянием модуля, чтобы поведение при сбое подписки
 * проверялось на своём экземпляре (test/eventBus.test.ts): общий к тому
 * моменту уже подписан другими файлами сюиты.
 */
export function createEventBus(listen: Listen) {
  const handlers = new Set<Handler>();
  let listening: Promise<void> | null = null;
  /* номер текущей попытки LISTEN; слушатели прежних попыток молчат */
  let attempt = 0;

  /**
   * Подписка процесса на канал; повторные вызовы переиспользуют удачную.
   *
   * Неудачная НЕ запоминается (внешний разбор 2026-09-26). Раньше
   * отклонённое обещание оставалось в `listening` навсегда: база не
   * ответила в момент первой подписки — и до перезапуска процесса каждая
   * новая вкладка консоли получала тот же старый отказ, хотя база давно
   * вернулась. Теперь отказ получает только тот, кто подписывался во время
   * сбоя; следующий пробует LISTEN заново.
   *
   * Слушатель неудачной попытки при этом не умирает: postgres.js держит
   * его у себя и после восстановления соединения сам повторяет LISTEN
   * (onclose его listen-клиента). Разбуди его и новый слушатель вместе —
   * каждое событие ушло бы подписчикам дважды. Поэтому слушатель знает
   * номер своей попытки и молчит, если попытка уже не текущая.
   */
  function ensureListening(): Promise<void> {
    if (listening) return listening;
    const mine = ++attempt;
    const current = listen(CHANNEL, (payload) => {
      if (mine !== attempt) return;
      try {
        const event = JSON.parse(payload) as AppEvent;
        for (const h of handlers) h(event);
      } catch {
        /* чужое сообщение в том же канале — не наша забота */
      }
    }).then(
      () => undefined,
      (error: unknown) => {
        if (listening === current) listening = null;
        log.warn("events.listen_failed", { error: String(error) });
        throw error;
      },
    );
    listening = current;
    return current;
  }

  /** Подписаться на события; возвращает функцию отписки */
  async function subscribe(handler: Handler): Promise<() => void> {
    await ensureListening();
    handlers.add(handler);
    return () => handlers.delete(handler);
  }

  return { subscribe };
}

const bus = createEventBus((channel, onNotify) => client.listen(channel, onNotify));

/** Подписаться на события процесса; возвращает функцию отписки */
export const subscribe = bus.subscribe;

export { db };
