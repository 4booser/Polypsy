import { beforeAll, describe, expect, test } from "bun:test";
import { eq, and, inArray } from "drizzle-orm";
import { db, makeUser } from "./fixtures";
import {
  appointments,
  departments,
  scheduleExceptions,
  scheduleTemplates,
  slots,
  specialistProfiles,
} from "../src/db/schema";
import { intervalsForDay, plannedSlots, sliceInterval, syncSlots } from "../src/lib/schedule";

/**
 * Сетка расписания.
 *
 * Главное здесь — не то, что слоты появляются, а то, что они появляются в
 * правильные моменты и что повторный прогон никого не трогает. Обе ошибки
 * тихие: слот на час не туда выглядит как настоящий, а лишний прогон,
 * снёсший занятый слот, обнаруживается, когда человек не пришёл.
 */

const KYIV = "Europe/Kyiv";

let departmentId: string;
let specialistId: string;

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення", ru: "Отделение" },
    timezone: KYIV,
  });
  const specialist = await makeUser("admin", `sched-${crypto.randomUUID()}@test`);
  specialistId = specialist.id;
  await db.insert(specialistProfiles).values({ userId: specialistId, departmentId });
});

describe("календарная арифметика", () => {
  test("интервал режется на слоты, хвост короче слота отбрасывается", () => {
    const pieces = sliceInterval({ from: "09:00", to: "10:40", slotMinutes: 50, kind: "any", capacity: 1 });
    expect(pieces).toEqual([
      { from: "09:00", to: "09:50" },
      { from: "09:50", to: "10:40" },
    ]);
  });

  test("остаток в двадцать минут слотом не становится", () => {
    // приём в 20 минут вместо 50 — это не приём, а строка в расписании
    const pieces = sliceInterval({ from: "09:00", to: "10:10", slotMinutes: 50, kind: "any", capacity: 1 });
    expect(pieces).toEqual([{ from: "09:00", to: "09:50" }]);
  });

  test("отпуск с часами разрывает интервал надвое", () => {
    const result = intervalsForDay(
      2,
      [{ weekday: 2, from: "09:00", to: "17:00", slotMinutes: 60, kind: "any", capacity: 1 }],
      [{ from: "12:00", to: "13:00" }],
      [],
    );
    expect(result.map((i) => [i.from, i.to])).toEqual([
      ["09:00", "12:00"],
      ["13:00", "17:00"],
    ]);
  });

  test("отпуск на весь день не оставляет ничего, кроме дополнительных часов", () => {
    const result = intervalsForDay(
      2,
      [{ weekday: 2, from: "09:00", to: "17:00", slotMinutes: 60, kind: "any", capacity: 1 }],
      [{ from: null, to: null }],
      [{ from: "18:00", to: "19:00", slotMinutes: 60, kind: "any", capacity: 1 }],
    );
    expect(result.map((i) => [i.from, i.to])).toEqual([["18:00", "19:00"]]);
  });

  test("шаблон другого дня недели в этот день не попадает", () => {
    const result = intervalsForDay(
      3,
      [{ weekday: 2, from: "09:00", to: "17:00", slotMinutes: 60, kind: "any", capacity: 1 }],
      [],
      [],
    );
    expect(result).toEqual([]);
  });
});

describe("перевод часов", () => {
  /**
   * Самая дорогая ошибка этой волны — и самая тихая.
   *
   * «Приём с девяти» означает девять по часам на стене и в марте, и в
   * ноябре. Если стенное время переводить в момент сложением смещения,
   * половина осени уедет на час: даты правдоподобные, приёмы не те, и
   * замечает это первый пациент, пришедший не вовремя.
   *
   * Проверяется через саму базу — тем же выражением, каким считает
   * генератор. Проверять расчёт его же формулой было бы бессмысленно, если
   * бы формула жила в коде; она живёт в Postgres, и здесь сверяется с
   * известными наперёд смещениями Киева: летом +3, зимой +2.
   */
  test("девять утра остаётся девятью и до перевода, и после", async () => {
    const rows = await db.execute<{ summer: string; winter: string }>(
      // 2025-10-26 — переход на зимнее время в Киеве
      `select
         ('2025-10-25 09:00'::timestamp at time zone '${KYIV}') as summer,
         ('2025-10-27 09:00'::timestamp at time zone '${KYIV}') as winter`,
    );
    const summer = new Date(rows[0]!.summer);
    const winter = new Date(rows[0]!.winter);

    // до перевода Киев на UTC+3, после — на UTC+2
    expect(summer.toISOString()).toBe("2025-10-25T06:00:00.000Z");
    expect(winter.toISOString()).toBe("2025-10-27T07:00:00.000Z");

    /*
     * И вот ради чего всё: разница между ними — не ровно двое суток.
     * Наивное сложение дало бы ровно 48 часов и потеряло бы час.
     */
    expect(winter.getTime() - summer.getTime()).toBe(49 * 3600 * 1000);
  });
});

describe("генерация", () => {
  test("шаблон превращается в слоты, повторный прогон ничего не меняет", async () => {
    await db.delete(scheduleTemplates).where(eq(scheduleTemplates.specialistId, specialistId));
    await db.delete(slots).where(eq(slots.specialistId, specialistId));
    await db.insert(scheduleTemplates).values({
      id: crypto.randomUUID(),
      specialistId,
      weekday: 2,
      startsAt: "09:00",
      endsAt: "12:00",
      slotMinutes: 60,
      kind: "any",
      capacity: 1,
    });

    const first = await syncSlots(specialistId, 2);
    // две недели, один день недели, три слота в день
    expect(first.added).toBeGreaterThan(0);
    const afterFirst = await db.select().from(slots).where(eq(slots.specialistId, specialistId));

    const second = await syncSlots(specialistId, 2);
    expect(second).toEqual({ added: 0, removed: 0, flagged: 0 });
    const afterSecond = await db.select().from(slots).where(eq(slots.specialistId, specialistId));
    expect(afterSecond.length).toBe(afterFirst.length);
  });

  test("слоты идут ровно по стенным часам отделения", async () => {
    const rows = await db
      .select({ startsAt: slots.startsAt })
      .from(slots)
      .where(eq(slots.specialistId, specialistId));
    expect(rows.length).toBeGreaterThan(0);

    const local = await db.execute<{ hh: string }>(
      `select distinct to_char(starts_at at time zone '${KYIV}', 'HH24:MI') as hh
       from slots where specialist_id = '${specialistId}' order by 1`,
    );
    expect(local.map((r) => r.hh)).toEqual(["09:00", "10:00", "11:00"]);
  });

  test("через перевод часов слоты остаются на девяти утра", async () => {
    /*
     * Проверка на самом генераторе, а не на Postgres.
     *
     * Горизонт растянут так, чтобы заведомо перешагнуть смену времени: если
     * стенное время когда-нибудь начнут переводить в момент сложением
     * смещения, слоты после перехода станут десятичасовыми, и вот эта
     * строка это увидит. Сравнивается стенное время, потому что обещано
     * пациенту именно оно.
     *
     * Специалист свой: длинный горизонт оставляет за собой сетку на девять
     * месяцев, и соседние проверки, считающие слоты, увидели бы чужое.
     */
    const long = await makeUser("admin", `sched-dst-${crypto.randomUUID()}@test`);
    await db.insert(specialistProfiles).values({ userId: long.id, departmentId });
    await db.insert(scheduleTemplates).values({
      id: crypto.randomUUID(),
      specialistId: long.id,
      weekday: 2,
      startsAt: "09:00",
      endsAt: "10:00",
      slotMinutes: 60,
      kind: "any",
      capacity: 1,
    });
    await syncSlots(long.id, 40);

    const hours = await db.execute<{ hh: string }>(
      `select distinct to_char(starts_at at time zone '${KYIV}', 'HH24:MI') as hh
       from slots where specialist_id = '${long.id}' order by 1`,
    );
    expect(hours.map((r) => r.hh)).toEqual(["09:00"]);

    /*
     * И перевод часов действительно попал в окно — иначе проверка выше
     * прошла бы, ничего не проверив. Смещение считается как разница между
     * стенным временем и тем же моментом в UTC.
     */
    const offsets = await db.execute<{ n: string }>(
      `select count(distinct (starts_at at time zone '${KYIV}') - (starts_at at time zone 'UTC')) as n
       from slots where specialist_id = '${long.id}'`,
    );
    expect(Number(offsets[0]!.n)).toBeGreaterThan(1);
  });

  test("суженный шаблон убирает свободные слоты", async () => {
    await db
      .update(scheduleTemplates)
      .set({ endsAt: "10:00" })
      .where(eq(scheduleTemplates.specialistId, specialistId));

    const result = await syncSlots(specialistId, 2);
    expect(result.removed).toBeGreaterThan(0);

    const local = await db.execute<{ hh: string }>(
      `select distinct to_char(starts_at at time zone '${KYIV}', 'HH24:MI') as hh
       from slots where specialist_id = '${specialistId}' order by 1`,
    );
    expect(local.map((r) => r.hh)).toEqual(["09:00"]);
  });

  test("занятый слот вне расписания остаётся и помечается", async () => {
    // возвращаем часы и заводим приём на 11:00
    await db
      .update(scheduleTemplates)
      .set({ endsAt: "12:00" })
      .where(eq(scheduleTemplates.specialistId, specialistId));
    await syncSlots(specialistId, 2);

    const eleven = await db.execute<{ id: string }>(
      `select id from slots
       where specialist_id = '${specialistId}'
         and to_char(starts_at at time zone '${KYIV}', 'HH24:MI') = '11:00'
       order by starts_at limit 1`,
    );
    const slotId = eleven[0]!.id;

    const patient = await makeUser("user", `sched-p-${crypto.randomUUID()}@test`);
    await db.insert(appointments).values({
      id: crypto.randomUUID(),
      slotId,
      patientId: patient.id,
      specialistId,
      kind: "primary",
    });

    // а теперь специалист сужает часы задним числом
    await db
      .update(scheduleTemplates)
      .set({ endsAt: "10:00" })
      .where(eq(scheduleTemplates.specialistId, specialistId));
    const result = await syncSlots(specialistId, 2);

    const [kept] = await db.select().from(slots).where(eq(slots.id, slotId));
    expect(kept).toBeDefined();
    expect(kept!.offSchedule).toBe(true);
    expect(result.flagged).toBeGreaterThan(0);
  });

  test("возвращённые часы снимают пометку", async () => {
    await db
      .update(scheduleTemplates)
      .set({ endsAt: "12:00" })
      .where(eq(scheduleTemplates.specialistId, specialistId));
    await syncSlots(specialistId, 2);

    const flagged = await db
      .select()
      .from(slots)
      .where(and(eq(slots.specialistId, specialistId), eq(slots.offSchedule, true)));
    expect(flagged).toEqual([]);
  });

  test("отпуск на день убирает слоты только этого дня", async () => {
    const planned = await plannedSlots(specialistId, 2);
    const day = planned[0]!.date;
    await db.insert(scheduleExceptions).values({
      id: crypto.randomUUID(),
      specialistId,
      date: day,
      kind: "off",
    });

    const after = await plannedSlots(specialistId, 2);
    expect(after.some((w) => w.date === day)).toBe(false);
    expect(after.length).toBe(planned.length - planned.filter((w) => w.date === day).length);
  });

  test("специалиста без профиля генерация не трогает", async () => {
    const stranger = await makeUser("admin", `sched-x-${crypto.randomUUID()}@test`);
    expect(await syncSlots(stranger.id, 2)).toEqual({ added: 0, removed: 0, flagged: 0 });
  });
});
