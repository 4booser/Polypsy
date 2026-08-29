import { beforeEach, describe, expect, test } from "bun:test";
import { memoryStore, resetStore } from "./store.mock";
import { cache } from "../src/offline/cache";
import { respondentFor } from "../src/offline/respondent";

/**
 * Режим обхода.
 *
 * Планшет в палате — место, где сети нет чаще, чем есть. Проверяется то, из-за
 * чего обход может тихо начать врать: возраст снимка и подмена того, чьи нормы
 * применяются при офлайн-подсчёте.
 */

beforeEach(() => {
  resetStore();
});

describe("кэш обхода", () => {
  test("список сохраняется с отметкой времени", () => {
    /*
     * Отметка обязательна: обход по вчерашнему списку выглядит ровно так же,
     * как по сегодняшнему, и молча показанный старый список хуже пустого
     * экрана — по нему ходят как по актуальному.
     */
    cache.saveRounds({ items: [{ id: "a" }] });
    const saved = cache.rounds();

    expect(saved?.rows).toEqual({ items: [{ id: "a" }] });
    expect(saved?.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("карты пациентов лежат раздельно", () => {
    cache.savePatientCard("p1", { fullName: "Первый" });
    cache.savePatientCard("p2", { fullName: "Второй" });

    expect((cache.patientCard("p1")?.card as { fullName: string }).fullName).toBe("Первый");
    expect((cache.patientCard("p2")?.card as { fullName: string }).fullName).toBe("Второй");
    expect(cache.patientCard("p3")).toBeNull();
  });

  test("повторное сохранение обновляет отметку", () => {
    cache.saveRounds({ items: [] });
    const first = cache.rounds()!.at;
    memoryStore.write("rounds:list", { at: "2020-01-01T00:00:00.000Z", rows: { items: [] } });
    expect(cache.rounds()!.at).not.toBe(first);

    cache.saveRounds({ items: [{ id: "b" }] });
    expect(cache.rounds()!.at > "2020-01-01T00:00:00.000Z").toBe(true);
  });
});

describe("чьи нормы применяются при подсчёте на устройстве", () => {
  // фиксированный «сейчас»: иначе тест на возраст ломался бы в день рождения
  const now = "2026-08-29T12:00:00.000Z";
  const me = { sex: "female" as const, birthDate: "1982-01-15" };

  test("в режиме обхода берутся данные пациента", () => {
    expect(respondentFor({ sex: "male", age: 21 }, me, now)).toEqual({ sex: "male", age: 21 });
  });

  test("без режима обхода берутся свои", () => {
    expect(respondentFor(null, me, now)).toEqual({ sex: "female", age: 44 });
    expect(respondentFor(undefined, me, now)).toEqual({ sex: "female", age: 44 });
  });

  test("неизвестные пол и возраст пациента не подменяются своими", () => {
    /*
     * У пациента может не быть паспортной части. Тогда честный ответ —
     * «нормы не применились», а не «применились нормы врача».
     */
    expect(respondentFor({ sex: null, age: null }, me, now)).toEqual({ sex: null, age: null });
  });

  test("без своей паспортной части нормы тоже не выдумываются", () => {
    expect(respondentFor(null, { sex: null, birthDate: null }, now)).toEqual({
      sex: null,
      age: null,
    });
  });
});

describe("стирание локальных данных", () => {
  test("уносит всё, что офлайн-слой сложил на устройство", async () => {
    /*
     * Включая очередь несданных прохождений. Это решено сознательно: в
     * очереди клинические ответы, которых больше нигде нет, и стирание их
     * теряет. Но команду отдают, когда устройство считают потерянным, — а
     * потерянное устройство с несданными ответами хуже, чем потеря ответов.
     */
    const { wipeLocalData, deviceId } = await import("../src/offline/device");
    const { enqueue } = await import("../src/offline/queue");

    cache.saveRounds({ items: [{ id: "a" }] });
    cache.savePatientCard("p1", { fullName: "Петров" });
    cache.saveSafetyPlan({ content: {} } as never);
    enqueue("s1", { answers: [] });
    const before = deviceId();

    const removed = wipeLocalData();

    expect(removed).toBeGreaterThan(3);
    expect(cache.rounds()).toBeNull();
    expect(cache.patientCard("p1")).toBeNull();
    expect(cache.safetyPlan()).toBeNull();

    /*
     * Идентификатор устройства тоже уходит: после стирания планшет должен
     * выглядеть новым, а не продолжать отзываться под прежним именем.
     */
    expect(deviceId()).not.toBe(before);
  });
});
