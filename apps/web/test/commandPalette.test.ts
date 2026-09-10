import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Каждая команда палитры обязана вести на существующий экран.
 *
 * Шесть из девятнадцати вели в никуда: «Расписание повторов», «Сеансы
 * киоска», «Сравнение», «Надзор», «Состояние подразделения» и «Создать сеанс
 * киоска» указывали на маршруты, которых в приложении нет. Их ловил общий
 * перехват и молча уводил на сводку — человек набирал «расписание», выбирал
 * и оказывался не там, где просил.
 *
 * Это хвост сквозных удалений: экраны убрали, рельсу почистили, палитру
 * забыли. Проверка читает исходники, а не открывает браузер: маршрут в
 * никуда — это несовпадение двух списков, и видеть его надо в тот момент,
 * когда списки разошлись.
 */

const ROOT = resolve(import.meta.dir, "../src");
const APP = readFileSync(resolve(ROOT, "App.tsx"), "utf8");
const PALETTE = readFileSync(resolve(ROOT, "shell/CommandPalette.tsx"), "utf8");

/** Пути, объявленные в приложении; параметрические приведены к образцу */
const declared = new Set(
  [...APP.matchAll(/path="([^"]+)"/g)].map((m) => m[1]!).filter((p) => p.startsWith("/")),
);

/** Куда ведут команды палитры */
const targets = [...PALETTE.matchAll(/to:\s*"([^"]+)"/g)].map((m) => m[1]!);

describe("палитра команд", () => {
  test("команд достаточно, чтобы проверка не была пустой", () => {
    expect(targets.length).toBeGreaterThan(8);
    expect(declared.size).toBeGreaterThan(20);
  });

  test("каждая команда ведёт на объявленный маршрут", () => {
    const missing = targets.filter((to) => !declared.has(to));
    expect(missing).toEqual([]);
  });
});
