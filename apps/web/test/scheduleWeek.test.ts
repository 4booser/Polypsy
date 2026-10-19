import { describe, expect, test } from "bun:test";
import type { AppointmentView, ScheduleExceptionView } from "@quizzy/shared";
import {
  addDays,
  apptLook,
  hourRange,
  mondayOf,
  movable,
  nextToday,
  placeDay,
  planDay,
  wallOf,
  weekDates,
  weekStats,
} from "../src/pages/schedule/model";

/**
 * Неделя календарём (pages/schedule/model.ts) — без браузера.
 *
 * Что здесь может тихо разъехаться с сервером: окна дня (сетка обязана быть
 * той же, что кладёт слоты, — иначе «3 з 6» на экране врёт), день приёма у
 * полуночи (по поясу отделения, а не браузера) и приёмы, стоящие друг на
 * друге (имя нижнего пряталось бы).
 */

const WEEK = [
  { weekday: 1, startsAt: "09:00", endsAt: "12:00", slotMinutes: 50 },
  { weekday: 1, startsAt: "14:00", endsAt: "17:00", slotMinutes: 50 },
  { weekday: 5, startsAt: "10:00", endsAt: "17:00", slotMinutes: 50 },
];

const exc = (over: Partial<ScheduleExceptionView>): ScheduleExceptionView => ({
  id: crypto.randomUUID(),
  date: "2026-10-23",
  kind: "off",
  startsAt: null,
  endsAt: null,
  slotMinutes: null,
  note: null,
  ...over,
});

const appt = (over: Partial<AppointmentView>): AppointmentView =>
  ({
    id: crypto.randomUUID(),
    slotId: crypto.randomUUID(),
    startsAt: "2026-10-19T07:00:00.000Z",
    endsAt: "2026-10-19T07:50:00.000Z",
    kind: "repeat",
    mode: "onsite",
    meetingUrl: null,
    status: "booked",
    specialistId: "s",
    specialistName: "S",
    room: null,
    patientId: "p",
    patientName: "Коваленко Оксана",
    reason: null,
    bookedAt: "2026-10-01T00:00:00.000Z",
    confirmedAt: null,
    offSchedule: false,
    pendingAssignments: 0,
    screeningDone: null,
    ...over,
  }) as AppointmentView;

describe("календарные даты", () => {
  test("понедельник недели и семь дней подряд — без поясов", () => {
    expect(mondayOf("2026-10-18")).toBe("2026-10-12");
    expect(mondayOf("2026-10-19")).toBe("2026-10-19");
    expect(weekDates("2026-10-19")).toEqual([
      "2026-10-19",
      "2026-10-20",
      "2026-10-21",
      "2026-10-22",
      "2026-10-23",
      "2026-10-24",
      "2026-10-25",
    ]);
    // неделя через перевод часов и через конец месяца — те же семь календарных дней
    expect(addDays("2026-10-26", 7)).toBe("2026-11-02");
  });

  test("день и час приёма — по поясу отделения, а не браузера", () => {
    // 21:30Z 25.10 — это 23:30 по Киеву (UTC+2 после перевода), то есть ещё 25-е
    expect(wallOf("2026-10-25T21:30:00.000Z", "Europe/Kyiv")).toEqual({ date: "2026-10-25", minutes: 23 * 60 + 30 });
    // 21:30Z 24.10 — 00:30 25-го по Киеву (UTC+3 до перевода)
    expect(wallOf("2026-10-24T21:30:00.000Z", "Europe/Kyiv")).toEqual({ date: "2026-10-25", minutes: 30 });
  });
});

describe("день глазами календаря", () => {
  test("окна — той же раскладкой, что у сервера: хвост короче приёма окном не становится", () => {
    const monday = planDay("2026-10-19", WEEK, []);
    // 09:00–12:00 по 50 минут — три окна (хвост 30 мин отброшен), 14:00–17:00 — ещё три
    expect(monday.windows).toBe(6);
    expect(monday.minutes).toBe(300);
    expect(monday.bands.map((b) => b.kind)).toEqual(["regular", "regular"]);
    expect(planDay("2026-10-24", WEEK, []).windows).toBe(0);
  });

  test("«не приймаю» с часами вырезает их из полосы и рисуется своей полосой", () => {
    const friday = planDay("2026-10-23", WEEK, [exc({ startsAt: "14:00", endsAt: "16:00", note: "супервізія" })]);
    const regular = friday.bands.filter((b) => b.kind === "regular").map((b) => [b.from, b.to]);
    expect(regular).toEqual([
      [600, 840],
      [960, 1020],
    ]);
    expect(friday.bands.find((b) => b.kind === "off")).toMatchObject({ from: 840, to: 960, note: "супервізія" });
  });

  test("«не приймаю» на весь день — ни полос, ни окон, только примечание", () => {
    const friday = planDay("2026-10-23", WEEK, [exc({ note: "конференція" })]);
    expect(friday.windows).toBe(0);
    expect(friday.bands).toEqual([]);
    expect(friday.offAllDay).toEqual({ note: "конференція" });
  });

  test("додаткові години — своя полоса и свои окна в дне без шаблона", () => {
    const saturday = planDay("2026-10-24", WEEK, [
      exc({ date: "2026-10-24", kind: "extra", startsAt: "10:00", endsAt: "13:00", slotMinutes: 60 }),
    ]);
    expect(saturday.windows).toBe(3);
    expect(saturday.bands).toEqual([{ from: 600, to: 780, kind: "extra", note: null }]);
  });
});

describe("приёмы в календаре", () => {
  test("пересекающиеся встают рядом, а не друг на друга; соседние — во всю ширину", () => {
    const placed = placeDay([
      { item: "a", start: 600, end: 650 },
      { item: "b", start: 620, end: 650 },
      { item: "c", start: 650, end: 700 },
    ]);
    const byItem = Object.fromEntries(placed.map((p) => [p.item, p]));
    expect(byItem.a).toMatchObject({ col: 0, cols: 2 });
    expect(byItem.b).toMatchObject({ col: 1, cols: 2 });
    // начался, когда первые два кончились, — новая группа, своя ширина
    expect(byItem.c).toMatchObject({ col: 0, cols: 1 });
  });

  test("вид: поза розкладом важнее состояния, пока приём живой; закрытый — по состоянию", () => {
    expect(apptLook({ status: "booked", offSchedule: true }, false)).toBe("off");
    expect(apptLook({ status: "done", offSchedule: true }, false)).toBe("done");
    expect(apptLook({ status: "no_show", offSchedule: false }, false)).toBe("noShow");
    expect(apptLook({ status: "in_progress", offSchedule: false }, false)).toBe("now");
    expect(apptLook({ status: "confirmed", offSchedule: false }, true)).toBe("now");
    expect(apptLook({ status: "confirmed", offSchedule: false }, false)).toBe("booked");
  });

  test("переносится только не начатый приём — как на сервере (RESCHEDULABLE)", () => {
    expect(movable({ status: "booked" })).toBe(true);
    expect(movable({ status: "confirmed" })).toBe(true);
    for (const s of ["arrived", "in_progress", "done", "no_show", "cancelled"] as const) expect(movable({ status: s })).toBe(false);
  });

  test("следующий — ближайший живой сегодня; закончившийся и завтрашний — нет", () => {
    const now = Date.parse("2026-10-19T09:00:00.000Z"); // 12:00 по Киеву
    const past = appt({ startsAt: "2026-10-19T07:00:00.000Z", endsAt: "2026-10-19T07:50:00.000Z" });
    const later = appt({ startsAt: "2026-10-19T13:00:00.000Z", endsAt: "2026-10-19T13:50:00.000Z" });
    const soon = appt({ startsAt: "2026-10-19T10:00:00.000Z", endsAt: "2026-10-19T10:50:00.000Z" });
    const tomorrow = appt({ startsAt: "2026-10-20T07:00:00.000Z", endsAt: "2026-10-20T07:50:00.000Z" });
    expect(nextToday([past, later, soon, tomorrow], "Europe/Kyiv", "2026-10-19", now)).toBe(soon.id);
  });

  test("числа недели: окна по сетке, занятые — без «поза розкладом», свободные — только впереди", () => {
    const plans = weekDates("2026-10-19").map((d) => planDay(d, WEEK, []));
    const inGrid = appt({});
    const off = appt({ offSchedule: true, startsAt: "2026-10-19T15:00:00.000Z", endsAt: "2026-10-19T15:50:00.000Z" });
    const slots = [
      { id: inGrid.slotId, startsAt: inGrid.startsAt, offSchedule: false },
      { id: "free-past", startsAt: "2026-10-19T06:00:00.000Z", offSchedule: false },
      { id: "free-ahead", startsAt: "2026-10-23T08:00:00.000Z", offSchedule: false },
      { id: off.slotId, startsAt: off.startsAt, offSchedule: true },
    ];
    const st = weekStats(plans, [inGrid, off], slots, "2026-10-26", Date.parse("2026-10-20T09:00:00.000Z"), "Europe/Kyiv");
    // понедельник 3 + 3 окна, пятница 10:00–17:00 — восемь по 50 минут
    expect(st.windows).toBe(6 + 8);
    expect(st.hours).toBe((300 + 400) / 60);
    expect(st.taken).toBe(1);
    expect(st.free).toBe(1);
    expect(st.off).toBe(1);
    expect(st.ahead).toBe(true);
    // прошедшая неделя — «вільно до кінця тижня» не показывается
    expect(weekStats(plans, [], [], "2026-10-26", Date.parse("2026-10-27T09:00:00.000Z"), "Europe/Kyiv").ahead).toBe(false);
  });

  test("часы календаря — от раннего начала до позднего конца, приём вне полос раздвигает их", () => {
    const plans = weekDates("2026-10-19").map((d) => planDay(d, WEEK, []));
    expect(hourRange(plans, [])).toEqual([9, 17]);
    expect(hourRange(plans, [{ start: 18 * 60 + 30, end: 19 * 60 + 20 }])).toEqual([9, 20]);
    expect(hourRange([], [])).toEqual([9, 18]);
  });
});
