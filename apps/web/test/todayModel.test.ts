import { describe, expect, test } from "bun:test";
import type { AlertCase, AppointmentView, WorkItem } from "@quizzy/shared";
import { UI } from "@quizzy/shared";
import {
  betweenSessions,
  caseTimer,
  clashes,
  dayAxis,
  dayTally,
  focusSession,
  hmm,
  lanes,
  liveCases,
  nowIndex,
  readiness,
  sessionStates,
  tallyParts,
  tallyText,
  urgentCases,
} from "../src/pages/today/model";

/** Строки словаря на языке — как их отдаёт ut() */
const tr = (lang: "uk" | "ru") => (k: never) => (UI as Record<string, Record<string, string>>)[k as string]?.[lang] ?? String(k);

/**
 * «Сьогодні» (Polypsy 2.0): шкала дня, состояния сессий, перетини,
 * готовность и порядок срочности — без браузера и без часов прогона.
 */

const at = (hm: string) => new Date(`2026-10-08T${hm}:00`).toISOString();

const appt = (id: string, from: string, to: string, over: Partial<AppointmentView> = {}): AppointmentView => ({
  id,
  slotId: `s-${id}`,
  startsAt: at(from),
  endsAt: at(to),
  kind: "repeat",
  mode: "onsite",
  meetingUrl: null,
  status: "confirmed",
  specialistId: "sp",
  specialistName: "Савчук І.",
  room: "214",
  patientId: `p-${id}`,
  patientName: `Пацієнт ${id}`,
  reason: null,
  bookedAt: at("08:00"),
  confirmedAt: null,
  offSchedule: false,
  pendingAssignments: 0,
  screeningDone: null,
  leadSpecialistId: "sp",
  ...over,
});

describe("шкала дня", () => {
  test("пустые часы от двух подряд сжимаются в одну метку, занятые остаются пропорциональными", () => {
    // 10:00–10:50, потом 17:30–18:20 и 19:00–19:50: с 11 до 17 — шесть пустых часов
    const spans = [
      { id: "a", start: 600, end: 650 },
      { id: "b", start: 1050, end: 1100 },
      { id: "c", start: 1140, end: 1190 },
    ];
    const axis = dayAxis(spans, 17 * 60)!;
    expect(axis.from).toBe(600);
    expect(axis.to).toBe(1200);
    expect(axis.gaps).toHaveLength(1);
    expect(axis.gaps[0]!.from).toBe(660);
    expect(axis.gaps[0]!.to).toBe(1020);
    // сжатый промежуток уже часа шкалы
    const hour = axis.at(1140) - axis.at(1080);
    expect(axis.gaps[0]!.widthPct).toBeLessThan(hour);
    // порядок сохраняется, края — 0 и 100
    expect(axis.at(600)).toBe(0);
    expect(axis.at(1200)).toBe(100);
    expect(axis.at(1050)).toBeGreaterThan(axis.at(1020));
  });

  test("«зараз» всегда на шкале: и в восемь вечера после дневного приёма", () => {
    const axis = dayAxis([{ id: "a", start: 540, end: 590 }], 20 * 60 + 40)!;
    expect(axis.to).toBe(21 * 60);
    expect(axis.at(20 * 60 + 40)).toBeGreaterThan(80);
    expect(axis.at(20 * 60 + 40)).toBeLessThanOrEqual(100);
  });

  test("без приёмов шкалы нет", () => {
    expect(dayAxis([], 600)).toBeNull();
  });

  test("перекрывающиеся блоки встают в две половины, ранний — сверху", () => {
    const l = lanes([
      { id: "a", start: 1050, end: 1100 },
      { id: "b", start: 1080, end: 1110 },
      { id: "c", start: 1140, end: 1190 },
    ]);
    expect(l.get("a")).toBe("top");
    expect(l.get("b")).toBe("bot");
    expect(l.get("c")).toBe("full");
  });
});

describe("сессии дня", () => {
  const items = [
    appt("1", "10:00", "10:50", { status: "done" }),
    appt("2", "14:00", "14:50"),
    appt("3", "17:30", "18:20"),
    appt("4", "19:00", "19:50", { status: "no_show" }),
    appt("5", "19:00", "19:30"),
  ];
  const now = Date.parse(at("17:00"));

  test("состояния: проведено, не отмечено, следующая, позже, неявка", () => {
    const s = sessionStates(items, now);
    expect(s.get("1")).toBe("done");
    expect(s.get("2")).toBe("late");
    expect(s.get("3")).toBe("next");
    expect(s.get("4")).toBe("noshow");
    expect(s.get("5")).toBe("later");
  });

  test("готовятся к идущей, иначе к следующей; другой день — к первой ждущей", () => {
    expect(focusSession(items, now)?.id).toBe("3");
    const here = items.map((a) => (a.id === "2" ? { ...a, status: "in_progress" as const } : a));
    expect(focusSession(here, now)?.id).toBe("2");
    expect(focusSession(items, null)?.id).toBe("2");
  });

  test("строка «Зараз» встаёт перед первой сессией, что начнётся позже", () => {
    expect(nowIndex(items, now)).toBe(2);
    expect(nowIndex(items, Date.parse(at("21:00")))).toBe(items.length);
  });

  /*
   * Счёт дня стоял в трёх местах и считался по-разному: шапка дня писала
   * «4 сесії: 1 проведено, 3 попереду», віджет зведення и конец таймлайна —
   * «1 проведено, 2 попереду» про тот же день. Один и тот же день (посев:
   * принят, пришёл, неотмеченный, ждущий) — одна строка везде.
   */
  test("счёт дня: одно правило, идущий приём — «триває», части складываются в число сессий", () => {
    const day = [
      appt("a", "09:00", "09:50", { status: "done" }),
      appt("b", "09:50", "10:40", { status: "arrived" }),
      // время прошло, явка не отмечена — всё ещё «попереду», и по часам счёт не меняется
      appt("c", "10:40", "11:30", { status: "confirmed" }),
      appt("d", "14:00", "14:50", { status: "booked" }),
      appt("e", "15:00", "15:50", { status: "cancelled" }),
    ];
    const t = dayTally(day);
    expect(t).toEqual({ total: 4, done: 1, noshow: 0, here: 1, ahead: 2 });
    expect(t.done + t.noshow + t.here + t.ahead).toBe(t.total);
    expect(tallyText(t, tr("uk"), "uk")).toBe("4 сесії: 1 проведено, 1 триває, 2 попереду");
    expect(tallyText(t, tr("ru"), "ru")).toBe("4 сессии: 1 проведено, 1 идёт, 2 впереди");
    // конец таймлайна — те же части без числа сессий
    expect(tallyParts(t, tr("uk"), "uk")).toBe("1 проведено, 1 триває, 2 попереду");

    // неявка — своей частью, нулевые части не называются, формы — по числу
    const later = dayTally([...day.slice(0, 1), appt("f", "11:00", "11:50", { status: "no_show" }), appt("g", "12:00", "12:50", { status: "no_show" })]);
    expect(later).toEqual({ total: 3, done: 1, noshow: 2, here: 0, ahead: 0 });
    expect(tallyText(later, tr("uk"), "uk")).toBe("3 сесії: 1 проведено, 2 неявки");
    expect(tallyText(dayTally([appt("h", "09:00", "09:50", { status: "in_progress" }), appt("i", "09:00", "09:50", { status: "arrived" })]), tr("uk"), "uk")).toBe(
      "2 сесії: 2 тривають",
    );
  });

  test("перетин — только между живыми приёмами: неявка его не создаёт", () => {
    const c = clashes(items);
    expect(c.has("5")).toBe(false);
    const two = clashes([...items, appt("6", "18:00", "18:30")]);
    expect(two.get("3")?.withId).toBe("6");
    expect(two.get("6")?.withId).toBe("3");
    expect(new Date(two.get("6")!.from).getHours()).toBe(18);
  });

  test("готовность: несданное — пропуск, подтверждение — с моментом, причина — своими словами", () => {
    const [m, b, r] = readiness(appt("x", "10:00", "10:50", { pendingAssignments: 2, status: "booked", reason: "не сплю" }));
    expect(m).toMatchObject({ key: "measures", tone: "miss", text: { key: "day.pending", n: 2 } });
    expect(b).toMatchObject({ key: "booking", tone: "miss", text: { key: "dayA.rdyUnconfirmed" } });
    expect(r).toMatchObject({ key: "reason", tone: "new" });
    const ok = readiness(appt("y", "10:00", "10:50", { screeningDone: true, confirmedAt: at("09:00") }));
    expect(ok[0]!.tone).toBe("ok");
    expect(ok[1]).toMatchObject({ tone: "ok", text: { key: "dayA.rdyConfirmed", at: at("09:00") } });
  });
});

const kase = (id: string, over: Partial<AlertCase> = {}): AlertCase => ({
  id,
  userId: `u-${id}`,
  userName: `Людина ${id}`,
  unit: null,
  surveyId: "s",
  surveyTitle: "PHQ-9",
  severity: "moderate",
  openedAt: at("14:12"),
  lastAlertAt: at("14:12"),
  signalCount: 1,
  signals: [],
  minutesOpen: 168,
  overdue: false,
  escalateMinutes: 240,
  assignedTo: null,
  assignedToName: null,
  acknowledgedBy: null,
  acknowledgedByName: null,
  acknowledgedAt: null,
  note: null,
  outcome: null,
  mergedFromLegacy: false,
  ...over,
});

describe("«Дія зараз»", () => {
  test("таймер — нормой методики: «2:48 з 4 год», до 18:12, лишилось 1:12", () => {
    const t = caseTimer(kase("a"))!;
    expect(t.elapsed).toBe("2:48");
    expect(t.norm).toBe(240);
    expect(t.left).toBe(72);
    expect(hmm(t.left)).toBe("1:12");
    expect(Math.round(t.pct)).toBe(70);
    expect(new Date(t.due).getHours()).toBe(18);
    expect(new Date(t.due).getMinutes()).toBe(12);
    expect(caseTimer(kase("b", { escalateMinutes: null }))).toBeNull();
  });

  test("порядок: свои и ничьи раньше чужих, тяжёлые раньше, затем меньше осталось до нормы", () => {
    const list = urgentCases(
      [
        kase("other", { assignedTo: "colleague", severity: "severe" }),
        kase("slow", { minutesOpen: 10 }),
        kase("soon", { minutesOpen: 230 }),
        kase("heavy", { severity: "severe", minutesOpen: 5 }),
        kase("done", { acknowledgedAt: at("15:00") }),
      ],
      "me",
    );
    expect(list.map((c) => c.id)).toEqual(["heavy", "soon", "slow", "other"]);
  });

  test("таймер идёт по часам экрана: экран открыт час — минут на час больше, норма пройдена — просрочено", () => {
    const loadedAt = Date.parse(at("17:00"));
    // ответ пришёл в 17:00: 2:48 из 4 год, лишилось 1:12
    const [fresh] = liveCases([kase("a")], loadedAt, loadedAt);
    expect(caseTimer(fresh!)!.elapsed).toBe("2:48");
    // через 30 минут без перечитывания — 3:18, лишилось 0:42
    const [half] = liveCases([kase("a")], loadedAt + 30 * 60_000, loadedAt);
    expect(caseTimer(half!)!.elapsed).toBe("3:18");
    expect(caseTimer(half!)!.left).toBe(42);
    expect(half!.overdue).toBe(false);
    // через 80 минут норма пройдена: случай просрочен и таймер говорит «понад»
    const [late] = liveCases([kase("a")], loadedAt + 80 * 60_000, loadedAt);
    expect(late!.minutesOpen).toBe(248);
    expect(late!.overdue).toBe(true);
    expect(caseTimer(late!)!.left).toBeLessThan(0);
    // разобранный не тикает; без момента ответа — как пришло
    const [done] = liveCases([kase("d", { acknowledgedAt: at("16:00") })], loadedAt + 80 * 60_000, loadedAt);
    expect(done!.minutesOpen).toBe(168);
    expect(liveCases([kase("a")], loadedAt + 80 * 60_000, null)[0]!.minutesOpen).toBe(168);
  });

  test("«Між сесіями» не повторяет человека героя и то, что уже стоит плитками", () => {
    const w = (id: string, userId: string): WorkItem => ({
      kind: "message",
      id,
      userId,
      userName: userId,
      unit: null,
      title: "",
      overdue: false,
      assignedTo: null,
      since: at("10:00"),
      href: "/",
    });
    const items = [w("1", "hero"), w("2", "a"), w("3", "b")];
    expect(betweenSessions(items, "hero", new Set(["message-3"])).map((i) => i.id)).toEqual(["2"]);
  });
});
