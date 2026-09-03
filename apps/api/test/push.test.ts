import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db, makeUser } from "./fixtures";
import { pushDeliveries, pushTokens } from "../src/db/schema";
import { pushToUser, setPushSenderForTests } from "../src/lib/push";

/**
 * Доставка уведомлений.
 *
 * Push здесь единственный канал: ни почты, ни SMS — внешних шлюзов нет, а
 * анонимный аккаунт получает напоминания наравне со всеми. Поэтому «не
 * дошло» означает «человек не узнал о завтрашнем приёме», и молчаливая
 * потеря недопустима.
 */
afterAll(() => setPushSenderForTests(null));

async function person(tag: string, withDevice: boolean) {
  const p = await makeUser("user", `push-${tag}-${crypto.randomUUID()}@test`);
  if (withDevice) {
    await db.insert(pushTokens).values({
      id: crypto.randomUUID(),
      userId: p.id,
      token: `ExponentPushToken[${crypto.randomUUID()}]`,
      platform: "ios",
    } as never);
  }
  return p;
}

const message = (key: string) => ({
  eventKey: key,
  kind: "appointment.reminder",
  title: "Приём завтра",
  body: "10:00, каб. 214",
});

describe("уведомления", () => {
  test("неудача не закрывает повтор навсегда", async () => {
    /*
     * Заявка оставалась с пометкой «не вышло», а уникальный ключ (человек,
     * событие) навсегда закрывал повтор: сеть моргнула на две секунды в
     * момент рассылки — и напоминание не придёт уже никогда.
     */
    const p = await person("retry", true);
    const key = `appointment:${crypto.randomUUID()}:day`;

    setPushSenderForTests(async () => {
      throw new Error("сеть моргнула");
    });
    expect(await pushToUser(p.id, message(key))).toBe(false);

    let sent = 0;
    setPushSenderForTests(async () => {
      sent += 1;
    });
    const second = await pushToUser(p.id, message(key));
    expect(second, "повтор после сбоя не состоялся — напоминание потеряно навсегда").toBe(true);
    expect(sent).toBe(1);
  });

  test("удачная отправка второй раз не тревожит", async () => {
    // идемпотентность — то, ради чего ключ и заведён
    const p = await person("once", true);
    const key = `appointment:${crypto.randomUUID()}:hour`;
    let sent = 0;
    setPushSenderForTests(async () => {
      sent += 1;
    });

    expect(await pushToUser(p.id, message(key))).toBe(true);
    expect(await pushToUser(p.id, message(key))).toBe(false);
    expect(sent).toBe(1);
  });

  test("человек без устройства не занимает ключ доставки", async () => {
    /*
     * Заявка вставлялась до проверки устройств, и человек без телефона
     * получал строку с признаком «успешно». Зарегистрировал телефон через
     * десять минут — напоминание за сутки ему уже не придёт.
     */
    const p = await person("nodevice", false);
    const key = `appointment:${crypto.randomUUID()}:day`;
    setPushSenderForTests(async () => {});

    expect(await pushToUser(p.id, message(key))).toBe(false);

    const rows = await db.select().from(pushDeliveries).where(eq(pushDeliveries.userId, p.id));
    expect(rows.length, "заявка занята доставкой, которой не было").toBe(0);
  });
});
