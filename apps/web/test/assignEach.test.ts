import { describe, expect, test } from "bun:test";
import { assignEach } from "../src/components/AssignDrawer";

/**
 * «Призначити» поимённо (components/AssignDrawer): каждому по очереди, отказ
 * одному не отменяет остальных — и в выборе остаются именно не прошедшие.
 *
 * Мутация: вернуть отбор по ФИО — в выборе остаются оба тёзки, и повтор
 * назначает тому, кому уже назначено.
 */
describe("назначение каждому по очереди", () => {
  test("тёзки: в выборе остаётся только тот, кому назначить не вышло", async () => {
    const people = [
      { id: "p1", fullName: "Іваненко Іван Іванович" },
      { id: "p2", fullName: "Іваненко Іван Іванович" },
      { id: "p3", fullName: "Бойко Тарас" },
    ];
    const asked: string[] = [];
    const result = await assignEach(people, async (id) => {
      asked.push(id);
      if (id === "p2") throw new Error("вже призначено");
    });
    expect(asked, "отказ одному оборвал остальных").toEqual(["p1", "p2", "p3"]);
    expect(result.done).toBe(2);
    expect(result.failed.map((p) => p.id)).toEqual(["p2"]);
    // причина — у не прошедшего, по id: ящик печатает её рядом с именем
    expect([...result.reasons]).toEqual([["p2", "вже призначено"]]);
  });

  test("все прошли — не прошедших нет; никто — все в списке", async () => {
    expect((await assignEach([{ id: "a" }, { id: "b" }], async () => {})).failed).toEqual([]);
    const none = await assignEach([{ id: "a" }, { id: "b" }], async () => {
      throw new Error("ні");
    });
    expect([none.done, none.failed.map((p) => p.id)]).toEqual([0, ["a", "b"]]);
  });
});
