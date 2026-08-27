import { describe, expect, test } from "bun:test";

/**
 * Гонка запросов.
 *
 * Проверяется не хук целиком (для этого нужен React), а его сердцевина —
 * правило «применять только последний ответ». Именно оно и было нарушено:
 * ответ по широкому периоду приходил позже и затирал данные по узкому, и
 * человек видел аналитику за период, который не запрашивал.
 *
 * Логика воспроизведена здесь один в один; расхождение с хуком поймает
 * компонентный тест, но саму суть дешевле проверить так.
 */

/** Та же схема, что в useResource: у каждой загрузки свой номер */
function makeLoader<T>() {
  let runId = 0;
  let applied: T | null = null;
  return {
    get value() {
      return applied;
    },
    run(load: () => Promise<T>) {
      const id = ++runId;
      return load().then((next) => {
        if (id !== runId) return;
        applied = next;
      });
    },
  };
}

const after = <T,>(ms: number, value: T) =>
  new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("отмена устаревших ответов", () => {
  test("медленный первый ответ не затирает быстрый второй", async () => {
    const l = makeLoader<string>();
    // широкий период отвечает 60 мс, узкий — 10 мс: узкий запрошен позже
    const slow = l.run(() => after(60, "широкий период"));
    const fast = l.run(() => after(10, "узкий период"));

    await Promise.all([slow, fast]);
    expect(l.value).toBe("узкий период");
  });

  test("подряд идущие запросы оставляют результат последнего", async () => {
    const l = makeLoader<number>();
    // человек печатает дату: четыре запроса подряд, времена вразнобой
    const runs = [
      l.run(() => after(40, 1)),
      l.run(() => after(5, 2)),
      l.run(() => after(30, 3)),
      l.run(() => after(15, 4)),
    ];
    await Promise.all(runs);
    expect(l.value).toBe(4);
  });

  test("одиночный запрос применяется", async () => {
    const l = makeLoader<string>();
    await l.run(() => after(1, "готово"));
    expect(l.value).toBe("готово");
  });

  test("отказ последнего не подставляет данные предыдущего", async () => {
    const l = makeLoader<string>();
    const first = l.run(() => after(30, "старое"));
    const second = l.run(() => Promise.reject(new Error("отказ"))).catch(() => {});
    await Promise.all([first, second]);
    /*
     * Старый ответ пришёл позже отказа, но он устарел — применять его
     * нельзя: экран показал бы данные, которых пользователь уже не просил.
     */
    expect(l.value).toBeNull();
  });
});
