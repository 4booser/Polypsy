import { describe, expect, test } from "bun:test";
import { kyivNow, NO_ROOM_TODAY, nextExtraWindow, pickSlotToday, type ExtraWindow } from "./slotWindow";

/**
 * Выбор времени приёма для сценариев e2e — на подменённых часах, без браузера
 * (волна 15, внешний разбор, п. 15).
 *
 * Было (e2e/helpers.ts, freeSlotToday): дата окна — сегодняшняя, а время —
 * «сейчас + N минут» с переходом через полночь. В 23:58 по Киеву помощник
 * заводил окно «сегодня 00:02–00:07» — в прошлом, свободного слота не
 * появлялось, и шесть-девять сценариев приёма падали на подготовке
 * (proof-test-clock.log ревьюера, e2e.log: 9 падений в конце суток).
 *
 * Стало (e2e/slotWindow.ts): день окна и время считаются от одного момента
 * по Киеву, окно через полночь не заводится; места до конца суток нет —
 * сценарий пропускается явно, с причиной. Сервер часами не подменяется:
 * подменены только часы самого помощника.
 */

/** Момент по стенным часам Киева: сентябрь — летнее время, UTC+3 */
const at = (utc: string) => Date.parse(utc);

describe("день и минута по Киеву", () => {
  test("день — киевский, а не машины и не UTC", () => {
    // 21:30 UTC — в Киеве уже следующий день
    expect(kyivNow(at("2026-09-27T21:30:00Z"))).toEqual({ date: "2026-09-28", minute: 30 });
    expect(kyivNow(at("2026-09-27T20:58:00Z"))).toEqual({ date: "2026-09-27", minute: 23 * 60 + 58 });
    // зимнее время, UTC+2
    expect(kyivNow(at("2026-12-31T21:58:00Z"))).toEqual({ date: "2026-12-31", minute: 23 * 60 + 58 });
  });
});

describe("окно дополнительного времени", () => {
  test("днём — ближайшее окно после запаса, в сегодняшнем дне", () => {
    const w = nextExtraWindow(at("2026-09-27T09:02:00Z"), new Set());
    // 12:02 по Киеву: запас 4 минуты — 12:06, окна по сетке пяти минут — 12:10
    expect(w).toEqual({ date: "2026-09-27", startsAt: "12:10", endsAt: "12:15" });
  });

  test("уже заведённые окна пропускаются, каждому вызову — своё", () => {
    const tried = new Set(["2026-09-27 12:10", "2026-09-27 12:15"]);
    expect(nextExtraWindow(at("2026-09-27T09:02:00Z"), tried)).toEqual({
      date: "2026-09-27",
      startsAt: "12:20",
      endsAt: "12:25",
    });
  });

  test("в 23:58 окна нет: «сегодня 00:02–00:07» больше не заводится", () => {
    // проба ревьюера: 2026-09-27 23:58 Europe/Kyiv
    expect(nextExtraWindow(at("2026-09-27T20:58:00Z"), new Set())).toBeNull();
  });

  test("окно не переходит через полночь и никогда не лежит в прошлом", () => {
    // каждая минута последнего часа суток, летом и зимой
    for (const base of ["2026-09-27T20:00:00Z", "2026-12-31T21:00:00Z"]) {
      for (let m = 0; m < 60; m += 1) {
        const now = at(base) + m * 60_000;
        const w = nextExtraWindow(now, new Set());
        if (!w) continue;
        const { date, minute } = kyivNow(now);
        expect(w.date).toBe(date);
        expect(w.endsAt > w.startsAt, `${w.startsAt}–${w.endsAt} через полночь`).toBe(true);
        const [h, mm] = w.startsAt.split(":").map(Number);
        expect(h! * 60 + mm!).toBeGreaterThan(minute);
      }
    }
  });

  test("последнее окно суток — 23:50–23:55; позже места нет", () => {
    expect(nextExtraWindow(at("2026-09-27T20:44:00Z"), new Set())).toEqual({
      date: "2026-09-27",
      startsAt: "23:50",
      endsAt: "23:55",
    });
    expect(nextExtraWindow(at("2026-09-27T20:47:00Z"), new Set())).toBeNull();
  });

  test("сразу после полуночи окно — уже в новом дне", () => {
    expect(nextExtraWindow(at("2026-09-27T21:01:00Z"), new Set())).toEqual({
      date: "2026-09-28",
      startsAt: "00:05",
      endsAt: "00:10",
    });
  });
});

/** Стенд без браузера: свободное время и заведённые окна — в памяти */
function stand(opts: { clock: () => number; gridFree?: string | null; layOut?: (w: ExtraWindow) => boolean }) {
  const added: ExtraWindow[] = [];
  let free: { id: string; date: string } | null = null;
  return {
    added,
    io: {
      now: opts.clock,
      freeToday: async (date: string) => {
        if (opts.gridFree) return opts.gridFree;
        return free && free.date === date ? free.id : null;
      },
      addWindow: async (w: ExtraWindow) => {
        added.push(w);
        if (opts.layOut?.(w) ?? true) free = { id: `slot-${w.date}-${w.startsAt}`, date: w.date };
      },
    },
  };
}

describe("выбор слота для сценария приёма", () => {
  test("днём заводится окно и берётся его слот", async () => {
    const s = stand({ clock: () => at("2026-09-27T09:02:00Z") });
    expect(await pickSlotToday(s.io, new Set())).toEqual({ slotId: "slot-2026-09-27-12:10" });
  });

  test("есть свободное время в сетке — окно не заводится", async () => {
    const s = stand({ clock: () => at("2026-09-27T09:02:00Z"), gridFree: "grid-1" });
    expect(await pickSlotToday(s.io, new Set())).toEqual({ slotId: "grid-1" });
    expect(s.added).toEqual([]);
  });

  test("в 23:58 — пропуск с причиной, а не падение и не окно в прошлом", async () => {
    const s = stand({ clock: () => at("2026-09-27T20:58:00Z") });
    expect(await pickSlotToday(s.io, new Set())).toEqual({ skip: NO_ROOM_TODAY });
    expect(s.added).toEqual([]);
  });

  test("окна упираются в полночь — пропуск, а не «пять часов подряд»", async () => {
    // окно поверх занятого слот не раскладывает (0105): свободного не появляется
    const s = stand({ clock: () => at("2026-09-27T20:30:00Z"), layOut: () => false });
    const pick = await pickSlotToday(s.io, new Set());
    expect(pick).toEqual({ skip: NO_ROOM_TODAY });
    // перепробованы все окна до конца суток — и ни одного через полночь
    expect(s.added.map((w) => w.startsAt)).toEqual(["23:35", "23:40", "23:45", "23:50"]);
    expect(s.added.every((w) => w.date === "2026-09-27")).toBe(true);
  });

  test("полночь наступила посреди подбора — пропуск, а не окно не того дня", async () => {
    let now = at("2026-09-27T20:40:00Z"); // 23:40 по Киеву: первое окно — 23:45–23:50
    const s = stand({
      clock: () => now,
      layOut: () => {
        now += 20 * 60_000; // пока заводилось окно, часы ушли за полночь
        return false;
      },
    });
    expect(await pickSlotToday(s.io, new Set())).toEqual({ skip: NO_ROOM_TODAY });
    expect(s.added).toEqual([{ date: "2026-09-27", startsAt: "23:45", endsAt: "23:50" }]);
  });

  test("свободного слота нет днём при месте в сутках — это поломка, а не пропуск", async () => {
    const s = stand({ clock: () => at("2026-09-27T06:00:00Z"), layOut: () => false });
    await expect(pickSlotToday(s.io, new Set(), 3)).rejects.toThrow();
  });
});
