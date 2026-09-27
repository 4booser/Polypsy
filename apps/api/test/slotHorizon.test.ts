import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, makeUser, users } from "./fixtures";
import { departments, scheduleTemplates, slots, specialistProfiles } from "../src/db/schema";
import { HORIZON_WEEKS, SLOT_HORIZON_JOB, extendSlotHorizon, syncSlots } from "../src/lib/schedule";

/**
 * Горизонт сетки слотов продлевается сам.
 *
 * Сетку строила только правка расписания: окно «восемь недель от сегодня»
 * сдвигалось каждый день, а сетка стояла, и у специалиста, не трогавшего
 * расписание два месяца, запись пустела молча. Теперь раз в сутки фоновая
 * задача (и руками — slotsResync.ts) пересобирает сетку всем тем же
 * syncSlots под тем же замком специалиста.
 *
 * Проход сужен до своих специалистов (`only`): пересобирать сетки всей
 * тестовой базы незачем, и чужие посевы не должны ронять эту проверку.
 */

const DAY = 86_400_000;
const mine: string[] = [];
let live: string;
let gone: string;
let broken: string;

async function specialist(tag: string, timezone: string): Promise<string> {
  const departmentId = crypto.randomUUID();
  await db.insert(departments).values({ id: departmentId, title: { uk: `Відділення ${tag}`, ru: `Отделение ${tag}` }, timezone });
  const person = await makeUser("admin", `horizon-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
  // каждый день, один часовой приём: в окне ровно по слоту на день
  await db.insert(scheduleTemplates).values(
    [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
      id: crypto.randomUUID(),
      specialistId: person.id,
      weekday,
      startsAt: "09:00",
      endsAt: "10:00",
      slotMinutes: 60,
    })),
  );
  mine.push(person.id);
  return person.id;
}

const openSlotsOf = (specialistId: string) =>
  db
    .select({ startsAt: slots.startsAt })
    .from(slots)
    .where(and(eq(slots.specialistId, specialistId), eq(slots.status, "open")));

beforeAll(async () => {
  live = await specialist("live", "Europe/Kyiv");
  // сетку когда-то собрали на две недели — и с тех пор не трогали
  await syncSlots(live, 2);

  gone = await specialist("gone", "Europe/Kyiv");
  await db.update(users).set({ disabledAt: new Date().toISOString() } as never).where(eq(users.id, gone));

  // пояс, которого Postgres не знает: пересборка этого специалиста падает
  broken = await specialist("broken", "Nowhere/Void");
});

afterAll(async () => {
  // свои слоты — прочь из общей записи; сломанного — выключить, чтобы чужой полный проход о него не споткнулся
  await db.delete(slots).where(inArray(slots.specialistId, mine));
  await db.update(users).set({ disabledAt: new Date().toISOString() } as never).where(eq(users.id, broken));
});

describe("продление горизонта", () => {
  test("сетка дотягивается до горизонта; кривая сетка соседа не останавливает проход", async () => {
    const before = await openSlotsOf(live);
    expect(before.length).toBe(14);

    // сломанный специалист в проходе есть — задача обязана стать «збій», но своих продлить
    await expect(extendSlotHorizon({ only: [live, gone, broken] })).rejects.toThrow(/1 из 2/);

    const after = await openSlotsOf(live);
    expect(after.length, "горизонт не продлился").toBe(HORIZON_WEEKS * 7);
    const last = Math.max(...after.map((s) => Date.parse(s.startsAt)));
    expect(last).toBeGreaterThan(Date.now() + (HORIZON_WEEKS * 7 - 2) * DAY);
  }, 30_000);

  test("выключенная учётка не продлевается", async () => {
    expect((await openSlotsOf(gone)).length).toBe(0);
  });

  test("повторный проход ничего не добавляет", async () => {
    const again = await extendSlotHorizon({ only: [live] });
    expect(again).toEqual({ specialists: 1, added: 0, removed: 0, flagged: 0, failed: 0 });
  }, 30_000);

  test("задача названа одним именем — его ищет подпись в техпанели", () => {
    expect(SLOT_HORIZON_JOB).toBe("slots.horizon");
  });
});
