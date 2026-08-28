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

export type AppEventKind =
  | "alert.created"
  | "case.changed"
  | "response.submitted"
  | "kiosk.progress"
  | "schedule.run"
  | "presence.changed";

export interface AppEvent {
  kind: AppEventKind;
  /**
   * Методики, к которым относится событие: событие видит тот, кому доступна
   * хотя бы одна из них. Список, а не одна методика, потому что события
   * киоска относятся к батарее целиком. `null` — системное событие,
   * видимое всем сотрудникам.
   */
  surveyIds: string[] | null;
  /** Кого касается; null у анонимных прохождений */
  userId: string | null;
  at: string;
  severity?: "moderate" | "severe";
  /** Сеанс киоска — чтобы открытый экран сеанса обновлял только себя */
  sessionId?: string;
  /** Экран, на котором находится сотрудник: `patient:<id>` и подобные */
  resource?: string;
}

type Handler = (event: AppEvent) => void;
const handlers = new Set<Handler>();
let listening: Promise<void> | null = null;

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

/** Подписка процесса на канал; повторные вызовы переиспользуют соединение */
async function ensureListening(): Promise<void> {
  if (listening) return listening;
  listening = client
    .listen(CHANNEL, (payload) => {
      try {
        const event = JSON.parse(payload) as AppEvent;
        for (const h of handlers) h(event);
      } catch {
        /* чужое сообщение в том же канале — не наша забота */
      }
    })
    .then(() => undefined);
  return listening;
}

/** Подписаться на события; возвращает функцию отписки */
export async function subscribe(handler: Handler): Promise<() => void> {
  await ensureListening();
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/** Сколько подписчиков сейчас держат поток — для метрик и диагностики */
export function subscriberCount(): number {
  return handlers.size;
}

export { db };
