import { beforeEach, describe, expect, test } from "bun:test";
import { resetStore } from "./store.mock";
import { discard, enqueue, flush, pending, pendingCount, rejectedItems, retryRejected } from "../src/offline/queue";

/**
 * Очередь несданных прохождений — самая дорогая логика мобильного приложения:
 * в ней лежат клинические ответы, которых больше нигде нет. Всё, что здесь
 * проверяется, — про «не потерять» и «не отправить дважды».
 */

class HttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const offline = () => new HttpError("Нет связи", 0);

beforeEach(() => {
  resetStore();
});

describe("накопление", () => {
  test("каждой сдаче выдаётся clientRequestId", () => {
    /*
     * Без него повторная отправка после потери ответа создала бы второе
     * прохождение — и человек попал бы в статистику дважды.
     */
    const a = enqueue("s1", { answers: [] });
    const b = enqueue("s1", { answers: [] });
    expect(a.payload.clientRequestId).toBeString();
    expect(a.payload.clientRequestId).not.toBe(b.payload.clientRequestId);
  });

  test("порядок сдачи сохраняется", async () => {
    // батареи со строгим порядком: методика 2 не должна уйти раньше первой
    const first = enqueue("s1", { n: 1 });
    await Bun.sleep(2);
    enqueue("s2", { n: 2 });
    await Bun.sleep(2);
    enqueue("s3", { n: 3 });

    expect(pending().map((x) => x.surveyId)).toEqual(["s1", "s2", "s3"]);
    expect(pending()[0]!.id).toBe(first.id);
  });
});

describe("прогон очереди", () => {
  test("успешные записи исчезают, счётчик обнуляется", async () => {
    enqueue("s1", {});
    enqueue("s2", {});

    const res = await flush(async () => {});

    expect(res).toEqual({ sent: 2, left: 0, rejected: 0 });
    expect(pending()).toHaveLength(0);
  });

  test("пропажа сети останавливает прогон, а не теряет очередь", async () => {
    enqueue("s1", {});
    enqueue("s2", {});
    enqueue("s3", {});

    let calls = 0;
    const res = await flush(async () => {
      calls++;
      if (calls > 1) throw offline();
    });

    // вторая попытка прервала проход: третью даже не пробовали
    expect(calls).toBe(2);
    expect(res.sent).toBe(1);
    expect(res.left).toBe(2);
    expect(pending().map((x) => x.surveyId)).toEqual(["s2", "s3"]);
  });

  test("сетевая ошибка не помечает запись отказом", async () => {
    /*
     * Разница принципиальная: отказ сервера требует разбора человеком,
     * а отсутствие сети пройдёт само. Пометить первое вторым — значит
     * оставить сдачу лежать до ручного вмешательства, которого не будет.
     */
    enqueue("s1", {});
    await flush(async () => {
      throw offline();
    });

    expect(rejectedItems()).toHaveLength(0);
    expect(pendingCount()).toBe(1);
  });

  test("отказ сервера помечает запись и не блокирует остальные", async () => {
    enqueue("bad", {});
    await Bun.sleep(2);
    enqueue("good", {});

    const res = await flush(async (item) => {
      if (item.surveyId === "bad") throw new HttpError("Методика архивирована", 409);
    });

    expect(res.sent).toBe(1);
    expect(res.rejected).toBe(1);
    const stuck = rejectedItems();
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.rejectedReason).toBe("Методика архивирована");
    // причина сохранена — сдача ждёт разбора, а не удалена молча
    expect(stuck[0]!.attempts).toBe(1);
  });

  test("отклонённая запись больше не отправляется сама", async () => {
    enqueue("bad", {});
    await flush(async () => {
      throw new HttpError("Отказ", 400);
    });

    let attempts = 0;
    const res = await flush(async () => {
      attempts++;
    });

    expect(attempts).toBe(0);
    expect(res.left).toBe(0); // в счётчик «ждёт отправки» отказ не входит
    expect(res.rejected).toBe(1);
  });

  test("параллельный вызов не отправляет одно и то же дважды", async () => {
    /*
     * Прогон запускают и восстановление сети, и открытие экрана. Без защиты
     * два прохода взяли бы один и тот же элемент — сервер спасёт
     * clientRequestId, но лишний трафик и гонка за store остаются.
     */
    enqueue("s1", {});
    let sends = 0;
    const slow = async () => {
      await Bun.sleep(10);
      sends++;
    };

    const [a, b] = await Promise.all([flush(slow), flush(slow)]);

    expect(sends).toBe(1);
    expect(a.sent + b.sent).toBe(1);
  });
});

describe("разбор отказов", () => {
  test("повтор снимает пометку и запись снова уходит", async () => {
    enqueue("bad", {});
    await flush(async () => {
      throw new HttpError("Отказ", 400);
    });

    retryRejected(rejectedItems()[0]!.id);
    expect(rejectedItems()).toHaveLength(0);

    const res = await flush(async () => {});
    expect(res.sent).toBe(1);
  });

  test("повтор сохраняет данные сдачи", async () => {
    // снятие пометки не должно попутно потерять ответы
    const item = enqueue("bad", { answers: [{ q: 1, v: "a" }] });
    await flush(async () => {
      throw new HttpError("Отказ", 400);
    });

    retryRejected(item.id);
    const back = pending()[0]!;
    expect(back.payload.answers).toEqual([{ q: 1, v: "a" }]);
    expect(back.payload.clientRequestId).toBe(item.payload.clientRequestId);
    expect("rejectedReason" in back).toBe(false);
  });

  test("удаление убирает запись насовсем", () => {
    const item = enqueue("s1", {});
    discard(item.id);
    expect(pending()).toHaveLength(0);
  });
});
