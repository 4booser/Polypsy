import { describe, expect, test } from "bun:test";
import { createEventBus, type AppEvent } from "../src/lib/events";

/**
 * Подписка процесса на канал событий переживает первую неудачу.
 *
 * Внешний разбор 2026-09-26: обещание подписки (LISTEN) запоминалось раз и
 * навсегда — и отклонённое тоже. База не ответила в момент первой
 * подписки (перезапуск Postgres, сеть) — и до перезапуска процесса каждая
 * новая вкладка консоли получала тот же старый отказ, хотя база давно
 * вернулась. Поток тревог молчал часами, ничего не сообщая.
 *
 * Проверяется на своём экземпляре шины с подменённым LISTEN: общий
 * экземпляр процесса к этому моменту уже подписан другими файлами сюиты.
 * Подмена ведёт себя как postgres.js: слушатель неудачной попытки драйвер
 * держит у себя и после восстановления соединения будит и его — поэтому
 * отдельно проверяется, что событие не приходит дважды.
 */

function fakeListen() {
  const registered: ((payload: string) => void)[] = [];
  let failuresLeft = 1;
  const listen = async (_channel: string, onNotify: (payload: string) => void) => {
    registered.push(onNotify);
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error("connect ECONNREFUSED");
    }
  };
  const notify = (event: Partial<AppEvent>) => {
    for (const fn of registered) fn(JSON.stringify(event));
  };
  return { listen, notify, attempts: () => registered.length };
}

describe("подписка на канал событий", () => {
  test("первая неудача не запоминается: следующая подписка пробует снова", async () => {
    const fake = fakeListen();
    const bus = createEventBus(fake.listen);

    await expect(bus.subscribe(() => {})).rejects.toThrow("ECONNREFUSED");

    // база вернулась — новая вкладка подписывается, а не получает старый отказ
    const got: AppEvent[] = [];
    const off = await bus.subscribe((e) => got.push(e));
    expect(fake.attempts(), "повторной попытки LISTEN не было — отказ взят из памяти").toBe(2);

    fake.notify({ kind: "ping" as AppEvent["kind"], at: "now" });
    expect(got, "событие пришло дважды: жив и слушатель неудачной попытки").toHaveLength(1);
    off();
  });

  test("удачная подписка одна на процесс", async () => {
    const fake = fakeListen();
    const bus = createEventBus(fake.listen);
    await bus.subscribe(() => {}).catch(() => {});
    await bus.subscribe(() => {});
    await bus.subscribe(() => {});
    expect(fake.attempts()).toBe(2);
  });
});
