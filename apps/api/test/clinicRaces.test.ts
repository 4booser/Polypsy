import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import postgres from "postgres";
import { api, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, users } from "../src/db/schema";
import { sweepNoShows } from "../src/lib/noShow";

/**
 * Переходы приёма, проверенные настоящей гонкой, а не парой запросов подряд.
 *
 * Общая причина дефектов из внешнего разбора (решение заказчика 2026-09-26):
 * проверка состояния отделена от его изменения. Обработчик читает приём,
 * решает по прочитанному и пишет по одному идентификатору — и всё, что
 * другой человек успел сделать между чтением и записью, молча затирается.
 *
 * Последовательные запросы этого не ловят: тестовый драйвер выполняет их по
 * очереди, и проверка сторожила бы пустоту (см. соседний тест в
 * clinic.test.ts). Поэтому здесь «другой человек» — второе соединение с
 * открытой транзакцией. Оно меняет строку приёма и держит её незакоммиченной;
 * проверяемый код в это время читает старое состояние (незакоммиченное ему
 * не видно), доходит до записи и упирается в замок строки. Только когда
 * видно, что он стоит в очереди за замком, второе соединение коммитит — и
 * запись проверяемого кода выполняется ровно в тот момент, который описан в
 * разборе: после чужого изменения, но с решением, принятым до него.
 *
 * Каждая проверка падала бы на прежнем коде: там запись шла по одному
 * идентификатору, и Postgres, дождавшись замка, послушно её выполнял.
 */

/** Второе соединение: им действует «другой человек» */
const other = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });

let departmentId: string;
let specialist: { id: string; token: string };
const mine: string[] = [];

/*
 * Своё время каждому слоту: с волны 12 открытые слоты одного специалиста не
 * пересекаются на уровне базы (миграция 0105), и два слота «через час от
 * сейчас» у одного специалиста больше не вставить.
 */
let seq = 0;
function nextWindow(direction: "past" | "future") {
  seq += 1;
  const hour = 3600_000;
  if (direction === "past") {
    // кончился больше двух часов назад — неявку уже пора ставить
    const end = Date.now() - 4 * hour - seq * 2 * hour;
    return { startsAt: new Date(end - hour).toISOString(), endsAt: new Date(end).toISOString() };
  }
  const start = Date.now() + 72 * hour + seq * 2 * hour;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + hour).toISOString() };
}

async function slotAt(direction: "past" | "future") {
  const id = crypto.randomUUID();
  await db.insert(slots).values({ id, specialistId: specialist.id, departmentId, ...nextWindow(direction) });
  return id;
}

/** Приём, заведённый напрямую: для неявки время должно уже пройти, а записаться на прошлое нельзя */
async function visit(tag: string, direction: "past" | "future", status: "booked" | "confirmed" = "booked") {
  const patient = await makeUser("user", `race-${tag}-${crypto.randomUUID()}@test`);
  const slotId = await slotAt(direction);
  const id = crypto.randomUUID();
  await db.insert(appointments).values({
    id,
    slotId,
    patientId: patient.id,
    specialistId: specialist.id,
    status,
    bookedBy: patient.id,
  });
  mine.push(id);
  return { id, slotId, patient };
}

/**
 * Дождаться, пока чей-то запрос встанет в очередь за замком строки.
 *
 * Ожидание по факту, а не по таймеру: «подождать сто миллисекунд» на
 * медленной машине проверяло бы не гонку, а скорость диска.
 */
async function waitForLockWaiter(fragment: string, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const [row] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query ilike ${`%${fragment}%`}
    `);
    if (Number(row?.n) > 0) return;
    await Bun.sleep(10);
  }
  throw new Error(`никто не встал в очередь за замком (${fragment}) — проверка не воспроизвела гонку`);
}

/**
 * Чужое изменение держится незакоммиченным, пока проверяемое действие не
 * упрётся в замок, и коммитится ровно тогда.
 */
async function meanwhile<T>(
  change: (tx: postgres.TransactionSql) => Promise<unknown>,
  action: () => Promise<T>,
  waitsOn: string,
): Promise<T> {
  let pending!: Promise<T>;
  await other.begin(async (tx) => {
    await change(tx);
    pending = action();
    // проигравший не должен упасть раньше, чем его дождутся
    pending.catch(() => {});
    await waitForLockWaiter(waitsOn);
  });
  return pending;
}

async function statusOf(id: string) {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
  return row!;
}

const UPDATE_APPOINTMENT = 'update "appointments"';

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення гонок стану", ru: "Отделение гонок состояния" },
    timezone: "Europe/Kyiv",
  });
  specialist = await makeUser("admin", `race-s-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: specialist.id, departmentId });
});

afterAll(async () => {
  /*
   * Ничего живого в общих очередях: напоминания, неявки и очередь работы
   * других файлов обходят всю базу.
   */
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(inArray(appointments.id, mine));
  }
  await other.end();
});

describe("фоновая неявка", () => {
  test("отмеченный между выборкой и записью приход неявкой не становится", async () => {
    /*
     * Воспроизведение из разбора: воркер выбрал booked, специалист в это
     * время отметил «пришёл», и воркер записал no_show по идентификатору —
     * человеку, который сидел в кабинете, ушла неявка и напоминание.
     */
    const { id } = await visit("ns-arrived", "past");
    await meanwhile(
      (tx) => tx`update appointments set status = 'arrived', arrived_at = now() where id = ${id}`,
      () => sweepNoShows(),
      UPDATE_APPOINTMENT,
    );
    expect((await statusOf(id)).status, "фоновый проход затёр отмеченный приход").toBe("arrived");
  }, 20_000);

  test("перенесённый между выборкой и записью приём неявкой не становится", async () => {
    // приём ушёл на будущее время — старый, истёкший слот больше не его
    const { id } = await visit("ns-moved", "past");
    const future = await slotAt("future");
    await meanwhile(
      (tx) => tx`update appointments set slot_id = ${future} where id = ${id}`,
      () => sweepNoShows(),
      UPDATE_APPOINTMENT,
    );
    const row = await statusOf(id);
    expect(row.slotId).toBe(future);
    expect(row.status, "перенесённый на будущее приём получил неявку по старому слоту").toBe("booked");
  }, 20_000);
});

describe("подтверждение", () => {
  test("отмена между чтением и записью не воскрешается подтверждением", async () => {
    const { id, patient } = await visit("cf-cancel", "future");
    const res = await meanwhile(
      (tx) =>
        tx`update appointments set status = 'cancelled', cancelled_at = now(), cancelled_by = ${patient.id} where id = ${id}`,
      () => api(`/api/clinic/appointments/${id}/confirm`, patient.token, { method: "POST" }),
      UPDATE_APPOINTMENT,
    );
    expect(res.status, "подтверждение прошло поверх отмены").not.toBe(200);
    const row = await statusOf(id);
    expect(row.status, "отменённый приём воскрес").toBe("cancelled");
    expect(row.confirmedAt).toBeNull();
  }, 20_000);

  test("подтверждение не переезжает на новое время вместе с переносом", async () => {
    /*
     * Подтверждение относится к времени, которое человек видел. Перенос
     * снимает его намеренно (см. маршрут переноса), и подтверждение,
     * записанное после переноса, приписало бы согласие времени, которого
     * человек не видел.
     */
    const { id, patient } = await visit("cf-moved", "future");
    const moved = await slotAt("future");
    const res = await meanwhile(
      (tx) => tx`update appointments set slot_id = ${moved}, confirmed_at = null where id = ${id}`,
      () => api(`/api/clinic/appointments/${id}/confirm`, patient.token, { method: "POST" }),
      UPDATE_APPOINTMENT,
    );
    expect(res.status).toBe(409);
    const row = await statusOf(id);
    expect(row.slotId).toBe(moved);
    expect(row.status).toBe("booked");
    expect(row.confirmedAt).toBeNull();
  }, 20_000);
});

describe("движение, перенос и отмена", () => {
  test("неявка, поставленная по прочитанному «записан», не затирает отмеченный приход", async () => {
    /*
     * Тот же случай, что с фоновым проходом, только руками: один сотрудник
     * видит «записан» и ставит неявку, другой в ту же секунду отметил
     * приход. Прежняя проверка пускала запись из любого состояния, откуда
     * переход вообще разрешён, — а из «пришёл» в неявку он разрешён.
     */
    const { id } = await visit("st-noshow", "future");
    const res = await meanwhile(
      (tx) => tx`update appointments set status = 'arrived', arrived_at = now() where id = ${id}`,
      () =>
        api(`/api/clinic/appointments/${id}/status`, specialist.token, {
          method: "POST",
          body: JSON.stringify({ status: "no_show" }),
        }),
      UPDATE_APPOINTMENT,
    );
    expect(res.status).toBe(409);
    expect((await statusOf(id)).status).toBe("arrived");
  }, 20_000);

  test("отмена не снимает человека, которого в это время отметили пришедшим", async () => {
    const { id, patient } = await visit("cn-arrived", "future");
    const res = await meanwhile(
      (tx) => tx`update appointments set status = 'arrived', arrived_at = now() where id = ${id}`,
      () =>
        api(`/api/clinic/appointments/${id}/cancel`, patient.token, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      UPDATE_APPOINTMENT,
    );
    expect(res.status).toBe(409);
    expect((await statusOf(id)).status).toBe("arrived");
  }, 20_000);

  test("отмена не уносит приём, который в это время перенесли", async () => {
    // поздняя ли отмена, считалось по прежнему слоту, а отменялся уже другой
    const { id, patient } = await visit("cn-moved", "future");
    const moved = await slotAt("future");
    const res = await meanwhile(
      (tx) => tx`update appointments set slot_id = ${moved} where id = ${id}`,
      () =>
        api(`/api/clinic/appointments/${id}/cancel`, patient.token, {
          method: "POST",
          body: JSON.stringify({}),
        }),
      UPDATE_APPOINTMENT,
    );
    expect(res.status).toBe(409);
    const row = await statusOf(id);
    expect(row.status).toBe("booked");
    expect(row.slotId).toBe(moved);
  }, 20_000);

  test("второй перенос не затирает первый", async () => {
    /*
     * Пациент и регистратор переносят один приём одновременно. Прежде
     * побеждал последний, а в журнале оставалось «из A в C» при том, что
     * приём уже стоял в B, — и время B освобождалось без следа.
     */
    const { id, patient } = await visit("rs-twice", "future");
    const first = await slotAt("future");
    const second = await slotAt("future");
    const res = await meanwhile(
      (tx) => tx`update appointments set slot_id = ${first}, confirmed_at = null where id = ${id}`,
      () =>
        api(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
          method: "POST",
          body: JSON.stringify({ slotId: second }),
        }),
      UPDATE_APPOINTMENT,
    );
    expect(res.status).toBe(409);
    expect((await statusOf(id)).slotId).toBe(first);
  }, 20_000);
});

describe("свой специалист", () => {
  test("снятие закрепления не снимает чужое, поставленное в это же время", async () => {
    /*
     * «Снять можно только своё» проверялось по прочитанному, а снималось по
     * идентификатору: коллега, закрепивший человека между чтением и записью,
     * терял закрепление, и переписка пациента уходила в никуда.
     */
    const { patient } = await visit("ld-release", "future");
    await db.update(users).set({ leadSpecialistId: specialist.id }).where(eq(users.id, patient.id));
    const colleague = await makeUser("admin", `race-colleague-${crypto.randomUUID()}@test`);

    const res = await meanwhile(
      (tx) => tx`update users set lead_specialist_id = ${colleague.id} where id = ${patient.id}`,
      () =>
        api(`/api/clinic/patients/${patient.id}/lead`, specialist.token, {
          method: "POST",
          body: JSON.stringify({ take: false }),
        }),
      "users",
    );
    expect(res.status).toBe(403);
    const [row] = await db.select().from(users).where(eq(users.id, patient.id));
    expect(row!.leadSpecialistId, "чужое закрепление снято").toBe(colleague.id);
  }, 20_000);
});
