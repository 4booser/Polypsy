import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { adminA, batteries, batteryItems, db, eq, groupA, runDueSchedules, scheduleRuns, schedules, sql, surveyInA } from "./fixtures";
import { asAppRole } from "./appRole";

/**
 * Расписание набора на подразделение в одиннадцать тысяч человек (#194).
 *
 * Прогон выдавал назначения одной вставкой: шесть параметров на строку, и
 * от 10 923 человек запрос выходил за потолок протокола (65 533) — сторож
 * db/sendGuard.ts отказывал сразу, транзакция прогона откатывалась, и отказ
 * повторялся на каждом следующем прогоне: подразделение не получало ничего.
 * Охват и закрытие пропусков шли параметром на человека — тот же потолок
 * чуть дальше. Теперь списки — одним параметром (db/ids.ts), вставки —
 * порциями.
 *
 * Прогон — под ролью приложения: в бою планировщик ходит ею же. Люди —
 * одной вставкой из generate_series, со своим подразделением: охват
 * расписания «по подразделению» берёт ровно их.
 */

const TAG = `w21-sched-${crypto.randomUUID().slice(0, 8)}`;
const PEOPLE = 11_000;
const unit = `Підрозділ-${TAG}`;
const batteryId = `${TAG}-battery`;
const scheduleId = `${TAG}-schedule`;

async function count(query: ReturnType<typeof sql>): Promise<number> {
  const [row] = (await db.execute(query)) as unknown as { n: number }[];
  return Number(row?.n ?? 0);
}

const assignments = (state: "open" | "cancelled") =>
  count(sql`select count(*)::int as n from battery_assignments
             where battery_id = ${batteryId}
               and ${state === "open" ? sql`cancelled_at is null and completed_at is null` : sql`cancelled_at is not null`}`);

beforeAll(async () => {
  await db.execute(sql`
    insert into users (id, email, password_hash, first_name, last_name, role, unit)
    select ${TAG} || '-u' || g, ${TAG} || '-u' || g || '@sched-scale.test', 'посів-без-входу',
           'Обсяг', 'Розклад', 'user', ${unit}
    from generate_series(1, ${PEOPLE}::int) g`);
  await db.execute(sql`analyze users`);
  await db.insert(batteries).values({
    id: batteryId,
    title: "Набір на підрозділ",
    groupId: groupA,
    strictOrder: false,
    createdBy: adminA.id,
  });
  await db.insert(batteryItems).values([{ batteryId, surveyId: surveyInA, position: 0, required: true }]);
  await db.insert(schedules).values({
    id: scheduleId,
    title: "Розклад на підрозділ",
    batteryId,
    scope: "unit",
    unit,
    intervalDays: 30,
    dueDays: 7,
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    active: true,
    createdBy: adminA.id,
  });
}, 60_000);

afterAll(async () => {
  // всё, что прогон завёл на людей, — явно; прогоны уходят каскадом от расписания, расписание — от набора
  await db.execute(sql`delete from battery_assignments where battery_id = ${batteryId}`);
  await db.execute(sql`delete from survey_access where user_id like ${`${TAG}-u%`}`);
  await db.execute(sql`delete from batteries where id = ${batteryId}`);
  /*
   * Сами люди — без проверки внешних ключей: на них ссылаются полсотни
   * таблиц, и удаление 11 тысяч строк с проверкой каждой ссылки идёт
   * минуту. Ссылок на них не осталось — всё, что завёл прогон, снято выше.
   */
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(sql`delete from users where id like ${`${TAG}-u%`}`);
  });
}, 60_000);

describe("расписание набора на 11 тыс. человек", () => {
  test("прогон выдаёт каждому назначение, состав и доступ", async () => {
    await asAppRole(() => runDueSchedules());

    const [run] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId));
    expect(run?.note ?? null).toBeNull();
    expect(run?.assigned).toBe(PEOPLE);
    expect(await assignments("open")).toBe(PEOPLE);
    expect(
      await count(sql`select count(*)::int as n from battery_assignment_items ai
                        join battery_assignments a on a.id = ai.assignment_id
                       where a.battery_id = ${batteryId} and ai.survey_id = ${surveyInA}`),
    ).toBe(PEOPLE);
    expect(
      await count(sql`select count(*)::int as n from survey_access
                       where survey_id = ${surveyInA} and user_id like ${`${TAG}-u%`}`),
    ).toBe(PEOPLE);
    // срок сдвинут: повторный прогон сейчас ничего не выдаёт
    await asAppRole(() => runDueSchedules());
    expect(await assignments("open")).toBe(PEOPLE);
  }, 120_000);

  test("следующий прогон закрывает просроченные пропуском и выдаёт новые всем", async () => {
    // срок назначений вышел, расписанию снова пора — только наши строки, чужие расписания не трогаем
    await db.execute(sql`update battery_assignments set due_at = now() - interval '1 day' where battery_id = ${batteryId}`);
    await db.execute(sql`update schedules set next_run_at = now() - interval '1 minute' where id = ${scheduleId}`);

    await asAppRole(() => runDueSchedules());

    const runs = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, scheduleId));
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.assigned).sort()).toEqual([PEOPLE, PEOPLE]);
    expect(await assignments("cancelled")).toBe(PEOPLE);
    expect(await assignments("open")).toBe(PEOPLE);
  }, 120_000);
});
