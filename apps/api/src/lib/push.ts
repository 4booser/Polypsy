import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { pushDeliveries, pushTokens } from "../db/schema";
import { log } from "./log";

/**
 * Пуш-уведомления через Expo Push API.
 *
 * В сообщении нет персональных данных и клинических подробностей: «назначено
 * обследование», «тревога в вашей группе». Экран блокировки видят посторонние
 * — в казарме, в транспорте, на построении, — и уведомление не должно
 * сообщать им ничего о состоянии человека.
 *
 * Отправка идемпотентна по ключу события: уведомление, ушедшее дважды,
 * приучает игнорировать уведомления, а это дороже, чем не отправить вовсе.
 */

export interface PushMessage {
  /** Ключ события: `assignment:<id>`; по нему же дедупликация */
  eventKey: string;
  kind: string;
  title: string;
  body: string;
  /** Куда открыть приложение */
  path?: string;
}

type Sender = (messages: { to: string; title: string; body: string; data?: unknown }[]) => Promise<void>;

/**
 * Отправщик подменяется в тестах.
 *
 * По умолчанию — Expo Push API: у приложения нет своего сервера доставки, а
 * заводить его ради двух типов сообщений значило бы взять на себя всю
 * возню с сертификатами Apple и ключами Google.
 */
let sender: Sender = async (messages) => {
  if (!messages.length) return;
  /*
   * С таймаутом: без него зависший (не отказавший) сервис уведомлений
   * держит соединение из пула базы столько, сколько ему угодно, а тик
   * рассылки идёт каждую минуту. Десять таких — и пул кончился, вместе с
   * ним и обслуживание запросов.
   */
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    signal: AbortSignal.timeout(15_000),
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(messages),
  });
  if (!res.ok) throw new Error(`expo push ${res.status}`);
};

export function setPushSenderForTests(next: Sender | null): void {
  sender =
    next ??
    (async () => {
      /* по умолчанию — ничего: тест, забывший подменить, не пойдёт наружу */
    });
}

/** Зарегистрировать устройство: повторная регистрация обновляет отметку */
export async function registerDevice(
  userId: string,
  token: string,
  platform: "ios" | "android" | "web",
): Promise<void> {
  await db
    .insert(pushTokens)
    .values({ id: crypto.randomUUID(), userId, token, platform })
    .onConflictDoUpdate({
      target: pushTokens.token,
      set: { userId, platform, lastSeenAt: new Date().toISOString() },
    });
}

export async function forgetDevice(token: string): Promise<void> {
  await db.delete(pushTokens).where(eq(pushTokens.token, token));
}

/**
 * Отправить уведомление человеку на все его устройства.
 *
 * Возвращает `false`, если сообщение уже уходило: вызывающий код может не
 * проверять это сам — идемпотентность живёт здесь, а не рассыпана по местам
 * отправки.
 */
export async function pushToUser(userId: string, message: PushMessage): Promise<boolean> {
  /*
   * Устройства проверяются ДО заявки на отправку.
   *
   * Раньше заявка вставлялась первой, и человек без зарегистрированного
   * устройства получал строку с признаком «успешно». Зарегистрировал
   * телефон через десять минут — напоминание за сутки ему уже не придёт
   * никогда: ключ (человек, событие) занят доставкой, которой не было.
   */
  const devices = await db.select().from(pushTokens).where(eq(pushTokens.userId, userId));
  if (!devices.length) return false;

  const [claimed] = await db
    .insert(pushDeliveries)
    .values({
      id: crypto.randomUUID(),
      userId,
      eventKey: message.eventKey,
      kind: message.kind,
    })
    .onConflictDoNothing()
    .returning({ id: pushDeliveries.id });

  // уже отправляли — второй раз не тревожим
  if (!claimed) return false;

  try {
    await sender(
      devices.map((d) => ({
        to: d.token,
        title: message.title,
        body: message.body,
        data: message.path ? { path: message.path } : undefined,
      })),
    );
    return true;
  } catch (error) {
    /*
     * Заявка снимается, чтобы следующий проход попробовал снова.
     *
     * Прежде она оставалась с пометкой «не вышло», а уникальный ключ
     * (человек, событие) навсегда закрывал повтор: сеть моргнула на две
     * секунды в момент рассылки — и напоминание о завтрашнем приёме не
     * придёт уже никогда. Push здесь единственный канал, второго нет.
     *
     * Отказ остаётся в журнале приложения; в таблице доставок ему делать
     * нечего — она отвечает на вопрос «отправляли ли», а не «пытались ли».
     */
    await db.delete(pushDeliveries).where(eq(pushDeliveries.id, claimed.id));
    log.warn("push.failed", { userId, kind: message.kind, error: String(error) });
    return false;
  }
}

/** Уведомить нескольких: используется для дежурных по группе */
export async function pushToUsers(userIds: string[], message: PushMessage): Promise<number> {
  let sent = 0;
  for (const id of userIds) if (await pushToUser(id, message)) sent++;
  return sent;
}

void and;
void inArray;
