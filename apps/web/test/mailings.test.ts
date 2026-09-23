import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanOptions, draftToInput, isFilled, MAX_OPTIONS } from "../src/pages/messages/model";
import { railGroups } from "../src/shell/Rail";
import { TOP } from "../src/shell/Topbar";

/**
 * Раздел «Повідомлення» (розсилки) и переписка — две двери, обе на месте.
 *
 * Тихая ошибка, ради которой это написано: пункт полосы «Повідомлення» и
 * экран переписки называются одним словом, и подмена адреса у пункта — или
 * потеря переписки из бургера — глазами не отличается: и то и другое
 * открывается, и на обоих экранах написано «повідомлення». Проверяется
 * состав навигации, а не отрисовка: маршруты читаются из App.tsx, пункты —
 * из тех же списков, из которых их читает оболочка.
 */

const APP = readFileSync(resolve(import.meta.dir, "../src/App.tsx"), "utf8");
const declared = new Set([...APP.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!));
const COUNTS = { today: 0, worklist: 0, alerts: 0, referrals: 0 };

describe("навигация раздела «Повідомлення»", () => {
  test("пункт верхней полосы ведёт на розсилки, а не на переписку", () => {
    expect(TOP.find((it) => it.key === "top.messages")?.to).toBe("/mailings");
  });

  test("переписка осталась по прежнему адресу и в бургере под своим именем", () => {
    /*
     * Переписку не удаляли и не переименовывали: её адрес объявлен, а в
     * бургере она стоит под заголовком собственного экрана («Листування») —
     * тем же ключом, что зовёт Messages.tsx, чтобы два «Повідомлення» не
     * вели на два разных экрана.
     */
    expect(declared.has("/messages"), "маршрут переписки пропал из App.tsx").toBe(true);
    const items = railGroups(COUNTS, false, false).flatMap((g) => g.items);
    const thread = items.find((i) => i.to === "/messages");
    expect(thread, "у переписки не осталось двери в бургере").toBeDefined();
    expect(thread!.key).toBe("ms.title");
  });

  test("все три экрана раздела объявлены", () => {
    for (const path of ["/mailings", "/mailings/new", "/mailings/:id"]) {
      expect(declared.has(path), `маршрут ${path} не объявлен в App.tsx`).toBe(true);
    }
  });
});

describe("черновик повідомлення", () => {
  test("пустые варианты выбрасываются, пробелы по краям снимаются", () => {
    /*
     * На кадре у варианта нет глифа «убрать»: единственный способ избавиться
     * от лишней кнопки — стереть текст. Пустое поле поэтому не ошибка, а
     * «убрать», и на сервер оно не уходит.
     */
    expect(cleanOptions([" Так ", "", "Ні", "   "])).toEqual(["Так", "Ні"]);
  });

  test("вариантов не больше потолка сервера", () => {
    const many = Array.from({ length: MAX_OPTIONS + 3 }, (_, i) => `в${i}`);
    expect(cleanOptions(many)).toHaveLength(MAX_OPTIONS);
  });

  test("невыбранная группа уходит null, а не пустой строкой", () => {
    /* селект не умеет null — пустая строка живёт только на экране; сервер ждёт nullish */
    const input = draftToInput({ title: " Тема ", body: "Текст", options: ["Так"], patientGroupId: "" });
    expect(input.patientGroupId).toBeNull();
    expect(input.title).toBe("Тема");
    /* поимённого списка экран не ведёт и не должен стирать его пустым массивом */
    expect("patientIds" in input).toBe(false);
  });

  test("сохранять нечего без названия и текста", () => {
    expect(isFilled({ title: " ", body: "Текст", options: [], patientGroupId: "" })).toBe(false);
    expect(isFilled({ title: "Тема", body: "", options: [], patientGroupId: "" })).toBe(false);
    expect(isFilled({ title: "Тема", body: "Текст", options: [], patientGroupId: "" })).toBe(true);
  });
});
