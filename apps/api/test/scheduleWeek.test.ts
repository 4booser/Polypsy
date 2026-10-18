import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inArray } from "drizzle-orm";
import { api, db, makeUser, type Person } from "./fixtures";
import { appointments, departments, scheduleExceptions, slots, specialistProfiles } from "../src/db/schema";

/**
 * Неделя календарём (GET /api/clinic/schedule/week).
 *
 * Экран расписания рисует неделю картиной: приёмы прошедших и будущих дней,
 * окна и исключения. Главное, что здесь может тихо разъехаться, — граница
 * дней: неделя считается по часам отделения, а не по поясу базы, и неделя с
 * переводом часов (25.10.2026, 25 часов) не теряет и не удваивает приёмы у
 * своих краёв. Второе — что отдаётся только своё: отменённые приёмы и
 * закрытые окна неделю не засоряют, а чужая неделя закрыта пациенту.
 */

let departmentId: string;
let specialist: Person;
let patient: Person;
const mine: string[] = [];

/** Момент, когда на часах Киева — заданные дата и время; смещение задаётся явно, чтобы тест не доверял проверяемому коду */
function kyiv(local: string, offset: "+02:00" | "+03:00"): string {
  return new Date(`${local}${offset}`).toISOString();
}

async function slotAt(startsAt: string, opts: { status?: "open" | "closed"; offSchedule?: boolean } = {}): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(slots).values({
    id,
    specialistId: specialist.id,
    departmentId,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 50 * 60_000).toISOString(),
    status: opts.status ?? "open",
    offSchedule: opts.offSchedule ?? false,
  });
  return id;
}

async function visitAt(startsAt: string, status: "booked" | "cancelled" = "booked"): Promise<string> {
  const slotId = await slotAt(startsAt);
  const id = crypto.randomUUID();
  await db.insert(appointments).values({ id, slotId, patientId: patient.id, specialistId: specialist.id, status });
  mine.push(id);
  return id;
}

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення тижня", ru: "Отделение недели" },
    timezone: "Europe/Kyiv",
  });
  specialist = await makeUser("admin", `sweek-s-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: specialist.id, departmentId });
  patient = await makeUser("user", `sweek-p-${crypto.randomUUID()}@test`);
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

describe("неделя календарём", () => {
  test("края недели — по местной полуночи, и в неделе с переводом часов тоже", async () => {
    // неделя 19.10–25.10.2026; 25.10 в 04:00 Киев переходит с UTC+3 на UTC+2
    const before = await visitAt(kyiv("2026-10-18T23:30:00", "+03:00"));
    const first = await visitAt(kyiv("2026-10-19T00:30:00", "+03:00"));
    const last = await visitAt(kyiv("2026-10-25T23:30:00", "+02:00"));
    const after = await visitAt(kyiv("2026-10-26T00:30:00", "+02:00"));
    const cancelled = await visitAt(kyiv("2026-10-21T10:00:00", "+03:00"), "cancelled");

    const res = await api(`/api/clinic/schedule/week?from=2026-10-19`, specialist.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.from).toBe("2026-10-19");
    expect(res.body.to).toBe("2026-10-26");
    expect(res.body.tz).toBe("Europe/Kyiv");
    const ids = (res.body.appointments as { id: string }[]).map((a) => a.id);
    expect(ids).toContain(first);
    expect(ids).toContain(last);
    expect(ids).not.toContain(before);
    expect(ids).not.toContain(after);
    // отменённый приём неделю не засоряет: его время свободно
    expect(ids).not.toContain(cancelled);
    // приём — тем же видом, что в «Сьогодні»: имя, состояние, пометка «поза розкладом»
    const row = (res.body.appointments as { id: string; patientName: string; status: string; offSchedule: boolean }[]).find(
      (a) => a.id === first,
    )!;
    expect(row.status).toBe("booked");
    expect(row.patientName.length).toBeGreaterThan(0);
    expect(row.offSchedule).toBe(false);
  });

  test("окна — только открытые, с пометкой «поза розкладом»; закрытые не отдаются", async () => {
    const open = await slotAt(kyiv("2026-11-02T09:00:00", "+02:00"));
    const flagged = await slotAt(kyiv("2026-11-03T18:00:00", "+02:00"), { offSchedule: true });
    const closed = await slotAt(kyiv("2026-11-04T09:00:00", "+02:00"), { status: "closed" });

    const res = await api(`/api/clinic/schedule/week?from=2026-11-02`, specialist.token);
    expect(res.status).toBe(200);
    const got = res.body.slots as { id: string; offSchedule: boolean }[];
    expect(got.map((s) => s.id)).toContain(open);
    expect(got.find((s) => s.id === flagged)?.offSchedule).toBe(true);
    expect(got.map((s) => s.id)).not.toContain(closed);
  });

  test("исключения — и прошедшие дни недели, и только этой недели", async () => {
    const inWeek = crypto.randomUUID();
    const nextWeek = crypto.randomUUID();
    await db.insert(scheduleExceptions).values([
      { id: inWeek, specialistId: specialist.id, date: "2026-11-10", kind: "off", note: "конференція", createdBy: specialist.id },
      {
        id: nextWeek,
        specialistId: specialist.id,
        date: "2026-11-16",
        kind: "extra",
        startsAt: "10:00",
        endsAt: "13:00",
        createdBy: specialist.id,
      },
    ]);
    const res = await api(`/api/clinic/schedule/week?from=2026-11-09`, specialist.token);
    expect(res.status).toBe(200);
    const got = res.body.exceptions as { id: string; kind: string; note: string | null; startsAt: string | null }[];
    expect(got.map((e) => e.id)).toEqual([inWeek]);
    expect(got[0]!.note).toBe("конференція");
    // весь день — без часов, а не «00:00»
    expect(got[0]!.startsAt).toBeNull();
  });

  test("days — один день для предпросмотра исключения", async () => {
    const monday = await visitAt(kyiv("2026-11-23T11:00:00", "+02:00"));
    const tuesday = await visitAt(kyiv("2026-11-24T11:00:00", "+02:00"));
    const res = await api(`/api/clinic/schedule/week?from=2026-11-23&days=1`, specialist.token);
    expect(res.status).toBe(200);
    expect(res.body.to).toBe("2026-11-24");
    const ids = (res.body.appointments as { id: string }[]).map((a) => a.id);
    expect(ids).toEqual([monday]);
    expect(ids).not.toContain(tuesday);
  });

  test("неверная дата — отказ словами, а не пятисотка", async () => {
    for (const bad of ["вчора", "2026-13-40", "2026-10-19T10:00"]) {
      const res = await api(`/api/clinic/schedule/week?from=${encodeURIComponent(bad)}`, specialist.token);
      expect(res.status, bad).toBe(400);
    }
    const tooLong = await api(`/api/clinic/schedule/week?from=2026-10-19&days=90`, specialist.token);
    expect(tooLong.status).toBe(400);
  });

  test("экран приёма: кабинет, подтверждение, пояс отделения и сколько приёмов уже было", async () => {
    await db.update(specialistProfiles).set({ room: "214" }).where(inArray(specialistProfiles.userId, [specialist.id]));
    const done = await visitAt(kyiv("2026-09-01T10:00:00", "+03:00"));
    const missed = await visitAt(kyiv("2026-09-08T10:00:00", "+03:00"));
    await db.update(appointments).set({ status: "done" }).where(inArray(appointments.id, [done]));
    await db.update(appointments).set({ status: "no_show" }).where(inArray(appointments.id, [missed]));
    const today = await visitAt(kyiv("2026-12-01T10:00:00", "+02:00"));
    const confirmedAt = new Date().toISOString();
    await db.update(appointments).set({ status: "confirmed", confirmedAt }).where(inArray(appointments.id, [today]));

    const res = await api(`/api/clinic/appointments/${today}/context`, specialist.token);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.appointment.specialistId).toBe(specialist.id);
    expect(res.body.appointment.room).toBe("214");
    expect(res.body.appointment.tz).toBe("Europe/Kyiv");
    expect(Date.parse(res.body.appointment.confirmedAt)).toBe(Date.parse(confirmedAt));
    expect(res.body.appointment.meetingUrl).toBeNull();
    // сам открытый приём в счёт не идёт; прошлые — по состоянию
    expect(res.body.visits.done).toBeGreaterThanOrEqual(1);
    expect(res.body.visits.noShow).toBeGreaterThanOrEqual(1);
  });

  test("пациенту неделя специалиста закрыта", async () => {
    const res = await api(`/api/clinic/schedule/week?from=2026-10-19&specialistId=${specialist.id}`, patient.token);
    expect(res.status).toBe(403);
  });
});
