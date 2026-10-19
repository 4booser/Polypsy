import { describe, expect, test } from "bun:test";
import type { ResponseAttempt, ResponseContextSignal } from "@quizzy/shared";
import { attemptNav, firstChange, mainScore, previousComparable, signalStrip, signalTimer } from "../src/pages/response/context";
import { scaleChange } from "../src/pages/response/model";
import { answer, detail, dynamics, score, series } from "./responseFixtures";

/**
 * Шапка над протоколом и переключатель попыток (Polypsy 2.0): что из
 * обстановки (GET /api/response-context/:id) попадает на экран.
 *
 * Ошибки здесь тихие: переключатель, читаемый задом наперёд, ответы по
 * пунктам, сравнённые с другой версией методики, таймер разбора «0:60»,
 * «спершу» там, где человек вернулся к первому ответу.
 */

const attempt = (id: string, day: number, value: number, versionNumber: number | null = 3): ResponseAttempt => ({
  id,
  submittedAt: `2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`,
  versionNumber,
  scores: [
    { code: "L", value: 2, band: null, severity: null },
    { code: "D", value, band: null, severity: null },
  ],
});

describe("переключатель попыток", () => {
  const six = [attempt("a1", 1, 21), attempt("a2", 5, 19), attempt("a3", 9, 16), attempt("a4", 13, 15), attempt("a5", 17, 14), attempt("a6", 21, 12)];

  test("последние попытки по возрастанию, число главной шкалы, соседи для «[» и «]»", () => {
    const nav = attemptNav(six, "a5", "D");
    expect(nav.chips.map((c) => [c.id, c.value, c.current])).toEqual([
      ["a3", 16, false],
      ["a4", 15, false],
      ["a5", 14, true],
      ["a6", 12, false],
    ]);
    expect(nav.total).toBe(6);
    expect([nav.prev, nav.next]).toEqual(["a4", "a6"]);
  });

  test("старый протокол — окно сдвигается к нему, а не показывает только свежие", () => {
    const nav = attemptNav(six, "a1", "D");
    expect(nav.chips.map((c) => c.id)).toContain("a1");
    expect(nav.chips.find((c) => c.current)!.id).toBe("a1");
    expect(nav.prev).toBeNull();
    expect(nav.next).toBe("a2");
  });

  test("незавершённое прохождение — без пометки «текущая» и без соседей", () => {
    const nav = attemptNav(six, "draft", "D");
    expect(nav.chips.some((c) => c.current)).toBe(false);
    expect([nav.prev, nav.next]).toEqual([null, null]);
  });

  test("главная шкала — содержательная, а не шкала достоверности", () => {
    expect(mainScore([score({ scaleCode: "L", kind: "validity" }), score({ scaleCode: "D" })])!.scaleCode).toBe("D");
  });

  test("ответы по пунктам сравниваются только внутри одной версии", () => {
    expect(previousComparable([attempt("a1", 1, 9), attempt("a2", 5, 8)], "a2")!.id).toBe("a1");
    expect(previousComparable([attempt("a1", 1, 9, 2), attempt("a2", 5, 8, 3)], "a2"), "сравнение с другой версией").toBeNull();
    expect(previousComparable([attempt("a1", 1, 9)], "a1")).toBeNull();
  });
});

const signal = (over: Partial<ResponseContextSignal>): ResponseContextSignal => ({
  id: "s",
  label: "сигнал",
  severity: "severe",
  at: "2026-10-08T11:12:00.000Z",
  here: true,
  questionId: null,
  surveyTitle: "PHQ-9",
  minutesOpen: 0,
  escalateMinutes: null,
  overdue: false,
  reviewedAt: null,
  reviewedByName: null,
  outcome: null,
  ...over,
});

describe("сигналы в строке открытого", () => {
  test("таймер — сколько висит против нормы разбора; без нормы таймера нет", () => {
    expect(signalTimer({ minutesOpen: 168, escalateMinutes: 240 }, "год")).toEqual({ elapsed: "2:48", of: "4 год", pct: 70 });
    expect(signalTimer({ minutesOpen: 61, escalateMinutes: 90 }, "год")).toEqual({ elapsed: "1:01", of: "1.5 год", pct: 68 });
    expect(signalTimer({ minutesOpen: 500, escalateMinutes: 240 }, "год")!.pct, "полоска за краем").toBe(100);
    expect(signalTimer({ minutesOpen: 30, escalateMinutes: null }, "год")).toBeNull();
  });

  test("открытые этого прохождения, открытые других замеров и разобранные — врозь; таймер — у самого старого", () => {
    const strip = signalStrip([
      signal({ id: "h1", minutesOpen: 30 }),
      signal({ id: "o1", here: false, minutesOpen: 300 }),
      signal({ id: "r1", reviewedAt: "2026-10-08T12:00:00.000Z" }),
    ]);
    expect(strip.openHere.map((s) => s.id)).toEqual(["h1"]);
    expect(strip.openElsewhere.map((s) => s.id)).toEqual(["o1"]);
    expect(strip.reviewedHere.map((s) => s.id)).toEqual(["r1"]);
    expect(strip.oldest!.id).toBe("o1");
    expect(signalStrip(null).oldest).toBeNull();
  });
});

describe("«спершу …, змінено через …»", () => {
  test("первый выбор и время до последней смены — по журналу ответа", () => {
    const a = answer({
      questionId: "q9",
      position: 9,
      optionIds: ["o1"],
      events: [
        { kind: "shown", elapsedMs: 0, at: "", value: null },
        { kind: "set", elapsedMs: 4_000, at: "", value: ["o0"] as unknown as string },
        { kind: "change", elapsedMs: 29_000, at: "", value: ["o1"] as unknown as string },
      ],
    });
    expect(firstChange(a)).toEqual({ firstOptionId: "o0", afterMs: 25_000 });
  });

  test("вернулся к первому ответу или менял один раз — пометки нет", () => {
    const back = answer({
      questionId: "q9",
      position: 9,
      optionIds: ["o0"],
      events: [
        { kind: "set", elapsedMs: 1_000, at: "", value: ["o0"] as unknown as string },
        { kind: "change", elapsedMs: 2_000, at: "", value: ["o1"] as unknown as string },
        { kind: "change", elapsedMs: 3_000, at: "", value: ["o0"] as unknown as string },
      ],
    });
    expect(firstChange(back)).toBeNull();
    const once = answer({ questionId: "q9", position: 9, optionIds: ["o0"], events: [{ kind: "set", elapsedMs: 1_000, at: "", value: ["o0"] as unknown as string }] });
    expect(firstChange(once)).toBeNull();
  });
});

describe("сдвиг этого замера", () => {
  test("от предыдущего и от старта; порог — MDC95 из SEM, вердикт по нему", () => {
    const dyn = dynamics([
      series(
        [
          { responseId: "r1", rawScore: 19 },
          { responseId: "r2", rawScore: 16 },
          { responseId: "r3", rawScore: 12 },
        ],
        { sem: 2 },
      ),
    ]);
    const c = scaleChange(detail(), dyn, "D", score().bands.map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity })))!;
    expect(c.rc).toBe(5.54);
    expect(c.better).toBe("down");
    expect([c.fromPrev!.delta, c.fromPrev!.verdict]).toEqual([-4, "within"]);
    expect([c.fromStart!.delta, c.fromStart!.verdict]).toEqual([-7, "better"]);
  });

  test("другая версия в паре — причина словом, а не вердикт по порогу; первое прохождение — без сдвига", () => {
    const dyn = dynamics([series([{ responseId: "r1", rawScore: 19, versionNo: 1 }, { responseId: "r3", rawScore: 12 }])]);
    const c = scaleChange(detail(), dyn, "D", [])!;
    expect(c.fromPrev!.verdict).toBe("version");
    expect(c.fromStart).toBeNull();
    const first = scaleChange(detail(), dynamics([series([{ responseId: "r3", rawScore: 12 }])]), "D", [])!;
    expect([first.fromPrev, first.fromStart]).toEqual([null, null]);
    expect(scaleChange(detail({ id: "elsewhere" }), dyn, "D", []), "незавершённое не в ряду").toBeNull();
  });
});
