import { beforeEach, describe, expect, test } from "bun:test";
import type { DynamicsPoint, RespondentDynamics, ScaleBand, ScaleDynamics, WorkItem } from "@quizzy/shared";
import { resetStore } from "./store.mock";
import { cache } from "../src/offline/cache";
import { setActiveOwner, signedIn } from "../src/offline/owner";
import {
  bandsOf,
  betterOf,
  byDay,
  caseClock,
  changeVerdict,
  clock,
  courseInput,
  dayKey,
  durationParts,
  hours,
  initials,
  instrumentRows,
  lastDays,
  num,
  roundsCounts,
  roundsMatch,
  roundsWards,
  shortName,
  toggleVisited,
  visitedOn,
} from "../src/staff/model";
import { flipVisited, visitedToday } from "../src/staff/visited";

/**
 * Экраны сотрудника на телефоне (src/staff/model.ts): то, что легко сломать
 * незаметно, — часы разбора, порядок обхода, слово у сдвига балла и полосы
 * графика курса.
 */

const MIN = 60_000;

describe("часы разбора сигнала", () => {
  const opened = "2026-10-08T14:12:00.000Z";
  const at = (minutes: number) => Date.parse(opened) + minutes * MIN;

  test("с нормой: прошло, доля, срок и сколько осталось", () => {
    const k = caseClock(opened, 240, at(168));
    expect(k.elapsed).toBe(168);
    expect(clock(k.elapsed)).toBe("2:48");
    expect(k.pct).toBe(70);
    expect(k.due?.toISOString()).toBe("2026-10-08T18:12:00.000Z");
    expect(k.left).toBe(72);
    expect(clock(k.left!)).toBe("1:12");
    expect(k.over).toBe(false);
  });

  test("от суток — днями, как в консоли: «9 дн.», а не «216:05»", () => {
    const days = "{n} дн.";
    expect(clock(9 * 24 * 60 + 5, days)).toBe("9 дн.");
    expect(clock(24 * 60, days)).toBe("1 дн.");
    expect(clock(24 * 60 - 1, days)).toBe("23:59");
    // без шаблона дней — часами, как было
    expect(clock(9 * 24 * 60 + 5)).toBe("216:05");
  });

  test("норма вышла — просрочено на столько, полоска не больше полной", () => {
    const k = caseClock(opened, 240, at(260));
    expect(k.over).toBe(true);
    expect(k.left).toBe(-20);
    expect(k.pct).toBe(100);
  });

  test("без нормы срока нет: ни «до 18:12», ни полоски — только сколько прошло", () => {
    for (const norm of [null, 0]) {
      const k = caseClock(opened, norm, at(30));
      expect(k).toEqual({ elapsed: 30, norm: null, pct: 0, due: null, left: null, over: false });
    }
  });

  test("часы нормы — без лишних нулей", () => {
    expect(hours(240)).toBe("4");
    expect(hours(90)).toBe("1,5");
  });
});

const item = (over: Partial<WorkItem>): WorkItem => ({
  kind: "followup",
  id: Math.random().toString(36).slice(2),
  userId: "u",
  userName: "Мельник Андрій Олегович",
  unit: "Денний стаціонар",
  title: "PHQ-9",
  overdue: false,
  assignedTo: null,
  since: "2026-10-01T00:00:00.000Z",
  href: "/",
  days: 0,
  ...over,
});

describe("обход по палатам", () => {
  const items = [
    item({ userId: "a", userName: "А", unit: "Ліва", days: 1 }),
    item({ userId: "b", userName: "Б", unit: "Ліва", days: 9, overdue: true, kind: "noshow" }),
    item({ userId: "a", userName: "А", unit: "Ліва", days: 4, overdue: true, kind: "assignment" }),
    item({ userId: "c", userName: "В", unit: null, days: 30, overdue: true }),
    item({ userId: "d", userName: "Г", unit: "Права", days: 2 }),
    item({ userId: "e", userName: "Д", unit: "Права", days: 3 }),
    item({ userId: "f", userName: "Е", unit: "Права", days: 1 }),
  ];

  test("строка — человек: два дела одного человека в одной палате — одна строка", () => {
    const wards = roundsWards(items, new Set());
    const left = wards.find((w) => w.unit === "Ліва")!;
    expect(left.people.map((p) => p.userId)).toEqual(["b", "a"]);
    const a = left.people.find((p) => p.userId === "a")!;
    expect(a.items.map((i) => i.kind)).toEqual(["assignment", "followup"]);
    expect(a.overdue).toBe(true);
    expect(a.days).toBe(4);
  });

  test("внутри палаты — сначала просроченное и самое давнее; палаты по числу людей, без подразделения — последней", () => {
    const wards = roundsWards(items, new Set());
    expect(wards.map((w) => w.unit)).toEqual(["Права", "Ліва", null]);
    expect(wards[0]!.people.map((p) => p.userId)).toEqual(["e", "d", "f"]);
  });

  test("отмеченные «відвідано» остаются на месте, а не уезжают в конец", () => {
    const before = roundsWards(items, new Set()).flatMap((w) => w.people.map((p) => p.userId));
    const after = roundsWards(items, new Set(["e", "b"])).flatMap((w) => w.people.map((p) => p.userId));
    expect(after).toEqual(before);
  });

  test("число за фильтром — ровно число строк, которые он покажет", () => {
    const wards = roundsWards(items, new Set(["d"]));
    const counts = roundsCounts(wards);
    expect(counts.all).toBe(6);
    expect(counts.overdue).toBe(3);
    expect(counts.visited).toBe(1);
    expect(counts.noshow).toBe(1);
    expect(counts.followup).toBe(5);
    for (const f of ["all", "overdue", "visited", "noshow", "followup", "assignment", "message"] as const) {
      expect(wards.flatMap((w) => w.people).filter((p) => roundsMatch(p, f)).length, f).toBe(counts[f]);
    }
  });
});

describe("отметки «відвідано»", () => {
  test("вчерашние не переносятся на сегодня", () => {
    const y = toggleVisited(null, "2026-10-07", "a");
    expect(visitedOn(y, "2026-10-07")).toEqual(new Set(["a"]));
    expect(visitedOn(y, "2026-10-08").size).toBe(0);
    // первая отметка нового дня начинает день заново, вчерашние не тянутся
    expect(toggleVisited(y, "2026-10-08", "b")).toEqual({ day: "2026-10-08", ids: ["b"] });
  });

  test("повторное нажатие снимает отметку", () => {
    const one = toggleVisited(null, "2026-10-08", "a");
    expect(toggleVisited(one, "2026-10-08", "a").ids).toEqual([]);
  });

  describe("на устройстве — под владельцем", () => {
    beforeEach(() => {
      resetStore();
    });

    test("отметки одного специалиста другому не видны и уходят с обходом при отказе доступа", () => {
      const now = new Date("2026-10-08T15:00:00");
      signedIn("s1");
      setActiveOwner("s1");
      expect(flipVisited("p1", now)).toEqual(new Set(["p1"]));
      expect(visitedToday(now)).toEqual(new Set(["p1"]));

      signedIn("s2");
      setActiveOwner("s2");
      expect(visitedToday(now).size).toBe(0);

      expect(cache.roundsVisited("s1")?.ids).toEqual(["p1"]);
      cache.dropRounds("s1");
      expect(cache.roundsVisited("s1")).toBeNull();
    });
  });
});

describe("сдвиг балла и его слово", () => {
  test("ровно на пороге — ещё в межах похибки, выше — надёжно", () => {
    expect(changeVerdict(-6, 6, "down")).toBe("within");
    expect(changeVerdict(-7, 6, "down")).toBe("better");
    expect(changeVerdict(7, 6, "down")).toBe("worse");
    expect(changeVerdict(7, 6, "up")).toBe("better");
  });

  test("без порога — неизвестно; без полярности — изменилось, но не «краще»", () => {
    expect(changeVerdict(-9, null, "down")).toBe("unknown");
    expect(changeVerdict(-9, 0, "down")).toBe("unknown");
    expect(changeVerdict(-9, 3, null)).toBe("changed");
  });

  const band = (minScore: number, maxScore: number, severity: ScaleBand["severity"], label = severity): ScaleBand =>
    ({ id: `${minScore}`, scaleId: "s", minScore, maxScore, label, severity, description: null, grade: null, recommendation: null, cascadeBatteryId: null, cascadeDueDays: null, followUpDays: null, position: 0 }) as ScaleBand;

  test("«краще ↓ / ↑» — по полосам самой шкалы", () => {
    expect(betterOf([band(0, 4, "none"), band(5, 9, "mild"), band(10, 27, "severe")])).toBe("down");
    expect(betterOf([band(0, 12, "severe"), band(13, 25, "none")])).toBe("up");
    expect(betterOf([band(0, 4, "severe"), band(5, 9, "none"), band(10, 14, "severe")])).toBeNull();
    expect(betterOf(null)).toBeNull();
  });

  test("полосы ищутся по id шкалы, а у другой версии — по коду", () => {
    const survey = { scales: [{ id: "x1", code: "PHQ", bands: [band(5, 9, "mild"), band(0, 4, "none")] }] } as never;
    expect(bandsOf(survey, { scaleId: "x1", code: "?" })?.map((b) => b.minScore)).toEqual([0, 5]);
    expect(bandsOf(survey, { scaleId: "other-version", code: "PHQ" })?.length).toBe(2);
    expect(bandsOf(survey, { scaleId: "nope", code: "nope" })).toBeNull();
    expect(bandsOf(null, { scaleId: "x1", code: "PHQ" })).toBeNull();
  });

  const point = (submittedAt: string, rawScore: number, over: Partial<DynamicsPoint> = {}): DynamicsPoint => ({
    responseId: submittedAt,
    submittedAt,
    rawScore,
    maxScore: 27,
    percent: (rawScore / 27) * 100,
    bandLabel: null,
    severity: null,
    percentile: null,
    ...over,
  });
  const scale = (over: Partial<ScaleDynamics>): ScaleDynamics => ({
    scaleId: "x1",
    code: "PHQ",
    title: "Депресія",
    points: [point("2026-08-24T10:00:00Z", 19), point("2026-09-11T10:00:00Z", 16), point("2026-10-08T10:00:00Z", 14)],
    delta: -5,
    direction: "down",
    reliableChange: { rci: -1.2, significant: false, direction: "down", basis: { sd: 5, alpha: 0.86, sampleN: 412 } },
    ...over,
  });
  const survey = { scales: [{ id: "x1", code: "PHQ", bands: [band(0, 4, "none"), band(5, 9, "mild"), band(10, 14, "moderate"), band(15, 27, "severe")] }] } as never;

  test("строка шкалы: история, сдвиг от старта, порог и слово", () => {
    const d = { surveys: [{ surveyId: "s", title: "PHQ-9", responseCount: 3, firstAt: null, lastAt: null, scales: [scale({})] }] } as RespondentDynamics;
    const [row] = instrumentRows(d, () => survey);
    expect(row!.history).toEqual([19, 16, 14]);
    expect(row!.delta).toBe(-5);
    expect(row!.better).toBe("down");
    // MDC95 = 1,96·√2·5·√(1−0,86) ≈ 5,19
    expect(row!.rc).toBeCloseTo(5.19, 1);
    expect(row!.verdict).toBe("within");
  });

  test("несравнимые замеры — сдвига нет, а не «−5»", () => {
    const d = { surveys: [{ surveyId: "s", title: "PHQ-9", responseCount: 3, firstAt: null, lastAt: null, scales: [scale({ incomparable: "version", delta: null })] }] } as RespondentDynamics;
    const [row] = instrumentRows(d, () => survey);
    expect(row!.delta).toBeNull();
    expect(row!.verdict).toBe("unknown");
  });

  test("график курса: полосы без щелей, верх — максимум шкалы, порог из недостоверного старта не рисуется", () => {
    const input = courseInput(scale({}), (survey as { scales: { bands: ScaleBand[] }[] }).scales[0]!.bands, null);
    expect(input.bands.map((b) => [b.from, b.to])).toEqual([
      [0, 5],
      [5, 10],
      [10, 15],
      [15, 27],
    ]);
    expect(input.min).toBe(0);
    expect(input.max).toBe(27);
    expect(input.better).toBe("down");
    expect(input.points.map((p) => p.label)).toEqual(["24.08", "11.09", "08.10"]);

    const shaky = scale({ points: [point("2026-08-24T10:00:00Z", 19, { reliable: false }), point("2026-10-08T10:00:00Z", 14)] });
    expect(courseInput(shaky, null, null).rc).toBeNull();
    // стены: верх — 10 из самой точки, даже без полос
    expect(courseInput(scale({ points: [point("2026-10-08T10:00:00Z", 7)] }), null, 10).max).toBe(10);
  });
});

describe("дни и подписи", () => {
  test("последние дни — с нулями там, где сдач не было", () => {
    const now = new Date(2026, 9, 8, 17, 0);
    const days = lastDays([{ date: "2026-10-08", count: 57 }, { date: "2026-10-05", count: 22 }], 5, now);
    expect(days.map((d) => [d.key, d.value])).toEqual([
      ["2026-10-04", 0],
      ["2026-10-05", 22],
      ["2026-10-06", 0],
      ["2026-10-07", 0],
      ["2026-10-08", 57],
    ]);
  });

  test("по дням — новые сверху, «сегодня» и «вчера» узнаются по давности", () => {
    const now = new Date(2026, 9, 8, 17, 0);
    const iso = (d: number, h: number) => new Date(2026, 9, d, h, 0).toISOString();
    const g = byDay([{ at: iso(7, 9) }, { at: iso(8, 14) }, { at: iso(8, 9) }, { at: null }], (r) => r.at, now);
    expect(g.map((x) => [x.day, x.ago, x.rows.length])).toEqual([
      [dayKey(now), 0, 2],
      ["2026-10-07", 1, 1],
      ["", Number.POSITIVE_INFINITY, 1],
    ]);
  });

  test("имя: инициалы фамилии и имени, короткая форма", () => {
    expect(initials("Мельник Андрій Олегович")).toBe("МА");
    expect(shortName("Мельник Андрій Олегович")).toBe("Мельник А. О.");
    expect(shortName("")).toBe("");
  });

  test("числа: запятая по-украински, точка по-английски; длительность — «3:12» или секунды", () => {
    expect(num(0.865, "uk")).toBe("0,87");
    expect(num(0.865, "en")).toBe("0.87");
    expect(num(14, "uk")).toBe("14");
    expect(durationParts(192_000)).toEqual({ value: "3:12", unit: "min" });
    expect(durationParts(43_300)?.unit).toBe("sec");
    expect(durationParts(0)).toBeNull();
  });
});
