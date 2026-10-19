import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { closedSinceOf, closedWithin, mergeReferrals } from "../src/pages/referrals/model";

/**
 * «Закриті за 30 днів» — отбором сервера (волна 27, perf-day).
 *
 * Группа собиралась из загруженных страниц реестра, а он идёт по дате
 * выписки: давнее направление, закрытое на днях, лежало за ними. Теперь экран
 * берёт закрытые за окно отдельным отбором (?closedSince=) и показывает их
 * вместе с загруженными, без повторов.
 */

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");

describe("граница окна", () => {
  test("с запасом в сутки: экран ещё раз отбирает по своему «сейчас»", () => {
    const since = Date.parse(closedSinceOf(NOW));
    expect(since).toBe(NOW - 31 * DAY);
    // всё, что closedWithin считает закрытым за 30 дней, сервер отдаст
    const edge = { status: "completed" as const, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: new Date(NOW - 30 * DAY).toISOString() };
    expect(closedWithin(edge, NOW)).toBe(true);
    expect(Date.parse(edge.updatedAt)).toBeGreaterThanOrEqual(since);
  });
});

describe("строки без повторов", () => {
  test("загруженные первыми, закрытые за окно — только недостающие", () => {
    const a = { id: "a", v: 1 };
    const b = { id: "b", v: 1 };
    const b2 = { id: "b", v: 2 };
    const c = { id: "c", v: 1 };
    expect(mergeReferrals([a, b], [b2, c])).toEqual([a, b, c]);
    expect(mergeReferrals([], [c])).toEqual([c]);
    expect(mergeReferrals([a], [])).toEqual([a]);
  });
});

describe("экран", () => {
  const src = readFileSync(resolve(import.meta.dir, "../src/pages/Referrals.tsx"), "utf8");

  test("закрытые за окно — своим отбором сервера, и после действия перечитываются оба", () => {
    expect(src).toContain("api.referrals(true, cursor, { closedSince })");
    expect(src).toContain("mergeReferrals(loaded, closedItems ?? [])");
    expect(src).toMatch(/page\.reload\(\);\s*closed\.reload\(\);/);
  });

  test("граница окна — одна на показ: иначе ключ загрузки менялся бы на каждой отрисовке", () => {
    expect(src).toContain("useState(() => closedSinceOf(Date.now()))");
  });
});
