import { afterAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { adminA, db, groupA, makeUser, runDueSchedules, surveyInA } from "./fixtures";
import { batteries, batteryAssignments, batteryItems, pushTokens, scheduleRuns, schedules } from "../src/db/schema";
import { dayOf, endOfDay } from "../src/lib/day";
import { setPushSenderForTests } from "../src/lib/push";

/**
 * Расписание повторных обследований: сбой, пропуск, выключенные учётки,
 * архивный набор, дата в уведомлении.
 *
 * У каждого теста своё подразделение (название с randomUUID) — охват
 * расписания считается по подразделению, и общий «Рота А» из фикстур
 * втянул бы людей соседних файлов. Прогоны с `now` из будущего задевают
 * все расписания базы, поэтому свои в конце выключаются.
 */

const DAY = 86_400_000;
const made: string[] = [];

afterAll(async () => {
  setPushSenderForTests(null);
  if (made.length) await db.update(schedules).set({ active: false }).where(inArray(schedules.id, made));
});

async function setup(opts: { intervalDays?: number; dueDays?: number; archived?: boolean; disabled?: number } = {}) {
  const unit = `Підрозділ ${crypto.randomUUID().slice(0, 8)}`;
  const batteryId = crypto.randomUUID();
  await db.insert(batteries).values({
    id: batteryId,
    title: `Набір ${unit}`,
    groupId: groupA,
    strictOrder: false,
    archived: opts.archived ?? false,
    createdBy: adminA.id,
  });
  await db.insert(batteryItems).values([{ batteryId, surveyId: surveyInA, position: 0, required: true }]);
  const person = await makeUser("user", `sr-${crypto.randomUUID()}@test`, { unit });
  const disabled = [];
  for (let i = 0; i < (opts.disabled ?? 0); i++) {
    disabled.push(
      await makeUser("user", `sr-off-${crypto.randomUUID()}@test`, { unit, disabledAt: new Date().toISOString() }),
    );
  }
  const id = crypto.randomUUID();
  const planned = new Date(Date.now() - 1000).toISOString();
  await db.insert(schedules).values({
    id,
    title: `Розклад ${unit}`,
    batteryId,
    scope: "unit",
    unit,
    intervalDays: opts.intervalDays ?? 30,
    dueDays: opts.dueDays ?? 7,
    startsAt: planned,
    nextRunAt: planned,
    active: true,
    createdBy: adminA.id,
  });
  made.push(id);
  return { id, batteryId, person, disabled, planned };
}

const assignmentsOf = (batteryId: string) =>
  db.select().from(batteryAssignments).where(eq(batteryAssignments.batteryId, batteryId));
const runsOf = (id: string) => db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleId, id));
const scheduleOf = async (id: string) => (await db.select().from(schedules).where(eq(schedules.id, id)))[0]!;

describe("сбой прохода", () => {
  test("временный сбой: повтор через четверть часа, а не через период; плановая сетка на месте", async () => {
    /*
     * Сбой сдвигал nextRunAt на следующий регулярный срок: база моргнула в
     * минуту прохода — и ежемесячный замер не выдавался месяц. Сбой здесь —
     * ошибка postgres на отметке о прогоне (триггер, как в batteries.test.ts):
     * только она откатывает транзакцию прохода целиком.
     */
    const s = await setup();
    await db.execute(
      sql.raw(`
      create or replace function quizzy_test_break_retry() returns trigger as $fn$
      begin
        if new.id = '${s.id}' and new.last_run_at is not null then
          raise exception 'підстроєний збій розкладу';
        end if;
        return new;
      end $fn$ language plpgsql`),
    );
    await db.execute(sql`
      create trigger quizzy_test_break_retry_trg before update on schedules
      for each row execute function quizzy_test_break_retry()`);

    const now = new Date();
    try {
      await runDueSchedules(now);
    } finally {
      await db.execute(sql`drop trigger if exists quizzy_test_break_retry_trg on schedules`);
      await db.execute(sql`drop function if exists quizzy_test_break_retry()`);
    }

    let row = await scheduleOf(s.id);
    expect(new Date(row.nextRunAt).getTime(), "сбой сдвинул плановый срок на период").toBe(new Date(s.planned).getTime());
    expect(row.failures).toBe(1);
    const retry = new Date(row.retryAt!).getTime();
    expect(retry).toBeGreaterThan(now.getTime());
    expect(retry).toBeLessThanOrEqual(now.getTime() + 15 * 60_000 + 1000);
    expect(await assignmentsOf(s.batteryId)).toHaveLength(0);

    // до срока повтора сломанное расписание не крутится каждый тик
    await runDueSchedules(new Date(now.getTime() + 5 * 60_000));
    expect(await runsOf(s.id)).toHaveLength(1);

    // срок повтора — выдаёт; следующий плановый считается от планового, а не от момента успеха
    await runDueSchedules(new Date(retry + 1000));
    expect(await assignmentsOf(s.batteryId)).toHaveLength(1);
    row = await scheduleOf(s.id);
    expect(row.retryAt).toBeNull();
    expect(row.failures).toBe(0);
    expect(new Date(row.nextRunAt).getTime()).toBe(new Date(s.planned).getTime() + 30 * DAY);
  });
});

describe("пропуск", () => {
  test("не пройденное в срок не выключает человека из расписания", async () => {
    /*
     * Незакрытое назначение считалось «занятостью» и после срока: человек,
     * пропустивший один замер, больше не получал ничего — ни через неделю,
     * ни через год. Теперь просроченное закрывается как пропущенное (с
     * отметкой, не молча), и выдаётся следующее.
     */
    const s = await setup({ intervalDays: 7, dueDays: 3 });
    const t0 = new Date();
    await runDueSchedules(t0);
    expect(await assignmentsOf(s.batteryId)).toHaveLength(1);

    await runDueSchedules(new Date(t0.getTime() + 7 * DAY + 60_000));
    const rows = await assignmentsOf(s.batteryId);
    expect(rows, "после пропуска расписание не выдало следующее").toHaveLength(2);
    const missed = rows.find((r) => r.cancelledAt);
    expect(missed?.note).toContain("пропущено");
    expect(rows.filter((r) => !r.cancelledAt && !r.completedAt)).toHaveLength(1);
  });

  test("не просроченное по-прежнему не дублируется", async () => {
    const s = await setup({ intervalDays: 7, dueDays: 10 });
    const t0 = new Date();
    await runDueSchedules(t0);
    // неделя прошла, а срок (10 дней) — ещё нет: второе задание подряд человек прочёл бы как ошибку
    await runDueSchedules(new Date(t0.getTime() + 7 * DAY + 60_000));
    const rows = await assignmentsOf(s.batteryId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cancelledAt).toBeNull();
  });
});

describe("кого расписание не охватывает", () => {
  test("выключенную учётку", async () => {
    const s = await setup({ disabled: 1 });
    await runDueSchedules();
    const rows = await assignmentsOf(s.batteryId);
    expect(rows.map((r) => r.userId)).toEqual([s.person.id]);
  });

  test("по архивному набору не назначает никому, и это записано", async () => {
    const s = await setup({ archived: true });
    await runDueSchedules();
    expect(await assignmentsOf(s.batteryId)).toHaveLength(0);
    const [run] = await runsOf(s.id);
    expect(run?.note).toContain("архив");
  });
});

describe("срок и дата в уведомлении", () => {
  test("срок — конец дня по поясу учреждения, и в пуше этот же день", async () => {
    /*
     * Срок был «ровно через N суток от минуты прохода», а дата в пуше —
     * `dueAt.slice(0, 10)`, то есть день по Гринвичу: ночью по Киеву это
     * вчерашнее число, и человеку писали «до 11-го» при сроке до 12-го.
     */
    const s = await setup({ dueDays: 7 });
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;
    await db.insert(pushTokens).values({ id: crypto.randomUUID(), userId: s.person.id, token, platform: "ios", lang: "uk" });
    const bodies: string[] = [];
    setPushSenderForTests(async (messages) => {
      for (const m of messages) if (m.to === token) bodies.push(m.body);
    });

    const now = new Date();
    await runDueSchedules(now);
    const [a] = await assignmentsOf(s.batteryId);
    const due = dayOf(new Date(now.getTime() + 7 * DAY).toISOString())!;
    expect(a!.dueAt && new Date(a!.dueAt).toISOString()).toBe(endOfDay(due));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(due);
  });
});
