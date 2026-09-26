import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { dayKey } from "../src/format";
import { groupByDay } from "../src/pages/Timeline";

/**
 * Хронология пациента: день — по часам учреждения, а не по Гринвичу
 * (волна 12, клиническое ревью).
 *
 * День брался срезом ISO, и всё, что случилось в Киеве после 21:00 летом
 * (22:00 зимой), уезжало в следующий день. Пояс задаётся явно: проверка не
 * должна зависеть от того, где стоит машина CI.
 */
const KYIV = "Europe/Kyiv";

describe("календарный день на границе суток", () => {
  test("лето (UTC+3): 23:59 — ещё сегодня, 00:00 — уже завтра", () => {
    expect(dayKey("2026-09-26T20:59:00Z", KYIV)).toBe("2026-09-26");
    expect(dayKey("2026-09-26T21:00:00Z", KYIV)).toBe("2026-09-27");
    // по Гринвичу оба — 26-е: ровно та ошибка, что была
    expect("2026-09-26T21:00:00Z".slice(0, 10)).toBe("2026-09-26");
  });

  test("зима (UTC+2): граница сдвигается на час", () => {
    expect(dayKey("2026-12-10T21:30:00Z", KYIV)).toBe("2026-12-10");
    expect(dayKey("2026-12-10T22:00:00Z", KYIV)).toBe("2026-12-11");
  });

  test("сутки перехода на зимнее время (25 жовтня 2026) — 25 часов, и граница не теряется", () => {
    // до перевода часов ещё лето: 21:00Z 24-го — это 00:00 25-го
    expect(dayKey("2026-10-24T21:00:00Z", KYIV)).toBe("2026-10-25");
    // после — уже зима: 21:59Z 25-го — это 23:59 того же 25-го
    expect(dayKey("2026-10-25T21:59:00Z", KYIV)).toBe("2026-10-25");
    expect(dayKey("2026-10-25T22:00:00Z", KYIV)).toBe("2026-10-26");
  });

  test("переход на летнее время (29 березня 2026)", () => {
    expect(dayKey("2026-03-28T21:59:00Z", KYIV)).toBe("2026-03-28");
    expect(dayKey("2026-03-28T22:00:00Z", KYIV)).toBe("2026-03-29");
    expect(dayKey("2026-03-29T20:59:00Z", KYIV)).toBe("2026-03-29");
    expect(dayKey("2026-03-29T21:00:00Z", KYIV)).toBe("2026-03-30");
  });

  test("неразборчивая строка не роняет ленту", () => {
    expect(dayKey("2026-09-26", KYIV)).toBe("2026-09-26");
    expect(dayKey("не дата", KYIV)).toBe("не дата".slice(0, 10));
  });
});

describe("лента по дням", () => {
  test("вечерняя тревога стоит под своим днём, а не под завтрашним", () => {
    const items = [
      { id: "morning", at: "2026-09-27T06:00:00Z" },
      { id: "late-alert", at: "2026-09-26T20:40:00Z" },
      { id: "past-midnight", at: "2026-09-26T21:30:00Z" },
      { id: "afternoon", at: "2026-09-26T12:00:00Z" },
    ];
    const byDay = groupByDay(items, KYIV);
    expect([...byDay.keys()]).toEqual(["2026-09-27", "2026-09-26"]);
    expect(byDay.get("2026-09-26")!.map((i) => i.id)).toEqual(["late-alert", "afternoon"]);
    expect(byDay.get("2026-09-27")!.map((i) => i.id)).toEqual(["morning", "past-midnight"]);
  });

  test("экран не режет день и время из строки", () => {
    const screen = readFileSync(resolve(import.meta.dir, "../src/pages/Timeline.tsx"), "utf8");
    expect(screen).not.toMatch(/\.at\.slice\(0, 10\)/);
    expect(screen).not.toMatch(/dateTime\([^)]*\)\.slice\(/);
  });
});
