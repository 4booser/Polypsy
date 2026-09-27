import { describe, expect, test } from "bun:test";
import { pastDeadline, today } from "../src/components/deadline";
import { assignCandidates, busyAssignees } from "../src/pages/batteries/model";

/**
 * Назначение набора человеку как состояние формы (w13:uitests): кого
 * предлагать и какой срок принимать.
 *
 * Обе ошибки тихие. Человек, которого нельзя найти поиском, выглядит как
 * «его нет в зоне», а не как «экран его прячет». Срок в прошлом выглядит
 * как назначение — только методики в кабинете не появляются.
 */

const row = (userId: string, over: Partial<{ cancelledAt: string | null; completedAt: string | null; overdue: boolean }> = {}) => ({
  userId,
  cancelledAt: null,
  completedAt: null,
  overdue: false,
  ...over,
});

const people = [
  { id: "u1", fullName: "Коваль Іван", email: "koval@clinic.ua" },
  { id: "u2", fullName: "Мельник Олег", email: "melnyk@clinic.ua" },
  { id: "u3", fullName: "Шевченко Ганна", email: "hanna@clinic.ua" },
  { id: "u4", fullName: "Бондар Петро", email: "bondar@clinic.ua" },
];

describe("кого предлагать", () => {
  test("открытое и не просроченное — «уже назначено», в предложениях его нет", () => {
    expect([...busyAssignees([row("u1")])]).toEqual(["u1"]);
    expect(assignCandidates(people, [row("u1")], "").map((p) => p.id)).toEqual(["u2", "u3", "u4"]);
  });

  test("просроченное — пропуск: сервер назначит заново, и экран обязан дать это сделать", () => {
    const rows = [row("u2", { overdue: true })];
    expect(busyAssignees(rows).has("u2")).toBe(false);
    expect(assignCandidates(people, rows, "мельник").map((p) => p.id)).toEqual(["u2"]);
  });

  test("пройденное и снятое не мешают назначить снова", () => {
    const rows = [row("u3", { completedAt: "2026-09-01T10:00:00Z" }), row("u4", { cancelledAt: "2026-09-02T10:00:00Z" })];
    expect(busyAssignees(rows).size).toBe(0);
  });

  test("поиск — по ФИО и почте, без учёта регистра и пробелов по краям; не больше восьми строк", () => {
    expect(assignCandidates(people, [], "  HANNA ").map((p) => p.id)).toEqual(["u3"]);
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, fullName: `Людина ${i}`, email: `m${i}@x.ua` }));
    expect(assignCandidates(many, [], "людина")).toHaveLength(8);
  });
});

describe("срок", () => {
  test("пусто — без срока, это допустимо", () => {
    expect(pastDeadline("", "2026-09-27")).toBe(false);
  });

  test("сегодня — можно: сервер читает дату как «до конца этого дня»", () => {
    expect(pastDeadline("2026-09-27", "2026-09-27")).toBe(false);
    expect(pastDeadline("2026-10-01", "2026-09-27")).toBe(false);
  });

  test("вчера и раньше — нельзя (опечатка в годе — тоже)", () => {
    expect(pastDeadline("2026-09-26", "2026-09-27")).toBe(true);
    expect(pastDeadline("2025-10-01", "2026-09-27")).toBe(true);
  });

  test("«сегодня» — по календарю консоли, в виде значения поля даты", () => {
    expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const noon = new Date(2026, 8, 27, 12, 0).getTime();
    expect(today(noon)).toBe("2026-09-27");
  });
});
