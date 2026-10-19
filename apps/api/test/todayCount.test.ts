import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppointmentView, TodayCount } from "@quizzy/shared";
import { api, db, makeUser, root, type Person } from "./fixtures";
import { appointments, auditLog, departments, permissionExceptions, slots, specialistProfiles } from "../src/db/schema";
import { requestSql } from "../src/lib/opsSql";

/**
 * Бейдж «Сьогодні» числом (волна 27, perf-day).
 *
 * Навигация опрашивала /api/clinic/today раз в минуту с каждой открытой
 * консоли: каждый такт расшифровывал ФИО и поводы всех приёмов дня и писал
 * clinic.today. Теперь у бейджа свой маршрут: то же число в том же круге —
 * свой день по часам отделения, без отменённых, ждут записанные и
 * подтвердившие, — но без людей и без строки журнала.
 *
 * Сверка — с самим /today: число обязано совпасть с тем, что навигация
 * считала по списку дня, иначе бейдж и экран дня разойдутся.
 */

let departmentId: string;
let specialist: Person;
let other: Person;
let denied: Person;
let patient: Person;
const mine: string[] = [];

/** Момент «HH:MM по часам Киева в этот день» — базой, а не часами теста */
async function kyivAt(day: string, hhmm: string): Promise<string> {
  const [row] = await db.execute<{ at: string }>(
    sql`select to_char(((${`${day} ${hhmm}`})::timestamp at time zone 'Europe/Kyiv') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at`,
  );
  return row!.at;
}

/** Приём: свой слот и строка приёма напрямую, без записи через API */
async function visit(who: Person, startsAt: string, status: AppointmentView["status"]): Promise<string> {
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId: who.id,
    departmentId,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
  });
  const id = crypto.randomUUID();
  await db.insert(appointments).values({ id, slotId, patientId: patient.id, specialistId: who.id, status } as never);
  mine.push(id);
  return id;
}

/** Ответ маршрута и счёт его SQL */
async function counted(path: string, who: Person) {
  const requestId = crypto.randomUUID();
  const res = await api(path, who.token, { headers: { "x-request-id": requestId } });
  return { ...res, sql: requestSql(requestId)?.count ?? 0 };
}

const todayRows = (actor: string) =>
  db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(and(eq(auditLog.actorId, actor), eq(auditLog.action, "clinic.today")))
    .then((r) => Number(r[0]?.n ?? 0));

let day: string;

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення бейджа дня", ru: "Отделение бейджа дня" },
    timezone: "Europe/Kyiv",
  });
  const tag = crypto.randomUUID().slice(0, 8);
  specialist = await makeUser("admin", `tcount-s-${tag}@test`);
  other = await makeUser("admin", `tcount-o-${tag}@test`);
  denied = await makeUser("admin", `tcount-d-${tag}@test`);
  patient = await makeUser("user", `tcount-p-${tag}@test`);
  for (const p of [specialist, other, denied]) {
    await db.insert(specialistProfiles).values({ userId: p.id, departmentId });
  }
  await db.insert(permissionExceptions).values({
    id: crypto.randomUUID(),
    userId: denied.id,
    permission: "patients.read",
    mode: "revoke",
    reason: "Проверка бейджа дня без права читать людей",
    grantedBy: root.id,
  });

  /* день — тот, что считает сервер: тест не спорит с ним о полуночи */
  const first = await api<TodayCount>("/api/clinic/today/count", specialist.token);
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  day = first.body.date;
  const [prev, next] = await db
    .execute<{ prev: string; next: string }>(
      sql`select to_char(${day}::date - 1, 'YYYY-MM-DD') as prev, to_char(${day}::date + 1, 'YYYY-MM-DD') as next`,
    )
    .then((r) => [r[0]!.prev, r[0]!.next]);

  // свой день: ждут двое (записан, подтвердил), остальные — уже нет
  await visit(specialist, await kyivAt(day, "00:30"), "booked");
  await visit(specialist, await kyivAt(day, "09:00"), "confirmed");
  await visit(specialist, await kyivAt(day, "10:00"), "arrived");
  await visit(specialist, await kyivAt(day, "11:00"), "in_progress");
  await visit(specialist, await kyivAt(day, "12:00"), "done");
  await visit(specialist, await kyivAt(day, "13:00"), "no_show");
  await visit(specialist, await kyivAt(day, "14:00"), "cancelled");
  // соседние сутки и чужой день в счёт не идут
  await visit(specialist, await kyivAt(prev!, "23:30"), "booked");
  await visit(specialist, await kyivAt(next!, "00:30"), "booked");
  await visit(other, await kyivAt(day, "09:00"), "booked");
});

afterAll(async () => {
  // ничего живого в общей очереди приёмов (порядок файлов в CI)
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(inArray(appointments.id, mine));
  }
});

describe("GET /api/clinic/today/count", () => {
  test("число — ждущие своего дня, то же, что навигация считала по /today", async () => {
    const count = await api<TodayCount>("/api/clinic/today/count", specialist.token);
    expect(count.status, JSON.stringify(count.body)).toBe(200);
    expect(count.body).toEqual({ date: day, waiting: 2 });

    const list = await api<{ date: string; items: AppointmentView[] }>("/api/clinic/today", specialist.token);
    expect(list.status).toBe(200);
    expect(list.body.date).toBe(day);
    const waiting = list.body.items.filter((a) => a.status === "booked" || a.status === "confirmed").length;
    expect(count.body.waiting).toBe(waiting);
  });

  test("без людей: в ответе только дата и число", async () => {
    const res = await api<TodayCount>("/api/clinic/today/count", specialist.token);
    expect(Object.keys(res.body).sort()).toEqual(["date", "waiting"]);
  });

  test("опрос числа не пишет clinic.today; просмотр самого дня — пишет, как прежде", async () => {
    const before = await todayRows(specialist.id);
    for (let i = 0; i < 3; i++) expect((await api("/api/clinic/today/count", specialist.token)).status).toBe(200);
    expect(await todayRows(specialist.id)).toBe(before);

    expect((await api("/api/clinic/today", specialist.token)).status).toBe(200);
    expect(await todayRows(specialist.id)).toBe(before + 1);
  });

  test("коллега видит своё число, а не чужое", async () => {
    const res = await api<TodayCount>("/api/clinic/today/count", other.token);
    expect(res.status).toBe(200);
    expect(res.body.waiting).toBe(1);
  });

  test("тот же заслон, что у дня: без patients.read и пациенту — отказ", async () => {
    expect((await api("/api/clinic/today/count", denied.token)).status).toBe(403);
    expect((await api("/api/clinic/today", denied.token)).status).toBe(403);
    expect((await api("/api/clinic/today/count", patient.token)).status).toBe(403);
  });

  /* порядок величин, а не точные числа: счёт SQL у /today растёт с приёмами дня, у числа — нет */
  test("число дешевле списка дня", async () => {
    const count = await counted("/api/clinic/today/count", specialist);
    const list = await counted("/api/clinic/today", specialist);
    expect(count.status).toBe(200);
    expect(list.status).toBe(200);
    expect(count.sql).toBeGreaterThan(0);
    expect(count.sql).toBeLessThan(list.sql);
    expect(count.sql).toBeLessThanOrEqual(10);
  });
});
