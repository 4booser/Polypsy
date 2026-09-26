import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { adminA, api, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, users } from "../src/db/schema";
import { underAppRole } from "./appRole";

/**
 * Запись только к тому, кто принимает.
 *
 * Дефект из внешнего разбора (решение заказчика 2026-09-26): снятая галочка
 * «принимает запись» убирала специалиста из списка, но выдача свободного
 * времени и само занятие слота её не проверяли — как и выключенную учётную
 * запись. Зная идентификатор слота (он живёт в ссылках и в кэше мобилки),
 * человек записывался к специалисту, который уже не принимает или уволился:
 * 201, приём в чужом дне, напоминание, а принять некому.
 */

let departmentId: string;
const mine: string[] = [];

let seq = 0;
async function futureSlot(specialistId: string) {
  seq += 1;
  const start = Date.now() + 96 * 3600_000 + seq * 2 * 3600_000;
  const id = crypto.randomUUID();
  await db.insert(slots).values({
    id,
    specialistId,
    departmentId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 3600_000).toISOString(),
  });
  return id;
}

async function specialist(tag: string, profile: { acceptsBookings?: boolean } = {}) {
  const person = await makeUser("admin", `gate-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId, ...profile });
  return person;
}

async function bookAs(token: string, slotId: string, patientId?: string) {
  const res = await api("/api/clinic/appointments", token, {
    method: "POST",
    body: JSON.stringify({ slotId, ...(patientId ? { patientId } : {}) }),
  });
  if (res.status === 201) mine.push(res.body.id);
  return res;
}

async function offered(token: string, specialistId: string) {
  const res = await api(`/api/clinic/slots?specialistId=${specialistId}`, token);
  expect(res.status).toBe(200);
  return res.body.items as { id: string }[];
}

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення запису", ru: "Отделение записи" },
    timezone: "Europe/Kyiv",
  });
});

afterAll(async () => {
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString() })
      .where(inArray(appointments.id, mine));
  }
});

describe("принимает ли специалист", () => {
  test("к принимающему записаться можно — проверка не мешает обычной записи", async () => {
    const open = await specialist("open");
    const slotId = await futureSlot(open.id);
    const patient = await makeUser("user", `gate-p0-${crypto.randomUUID()}@test`);
    expect((await offered(patient.token, open.id)).map((s) => s.id)).toContain(slotId);
    expect((await bookAs(patient.token, slotId)).status).toBe(201);
  });

  test("снятая галочка закрывает и выдачу времени, и запись по идентификатору", async () => {
    const paused = await specialist("paused", { acceptsBookings: false });
    const slotId = await futureSlot(paused.id);
    const patient = await makeUser("user", `gate-p1-${crypto.randomUUID()}@test`);

    expect(await offered(patient.token, paused.id), "время неприёмного специалиста выдано").toEqual([]);
    const res = await bookAs(patient.token, slotId);
    expect(res.status, "запись к неприёмному специалисту прошла напрямую").toBe(400);
    expect(res.body.code ?? res.body.error).toBeDefined();

    // и сотрудник с правом записывать за других тоже не обходит галочку
    const byStaff = await bookAs(adminA.token, slotId, patient.id);
    expect(byStaff.status).toBe(400);

    const [none] = await db.select().from(appointments).where(eq(appointments.slotId, slotId));
    expect(none).toBeUndefined();
  });

  test("перенос на время неприёмного специалиста тоже закрыт", async () => {
    const open = await specialist("open2");
    const paused = await specialist("paused2", { acceptsBookings: false });
    const patient = await makeUser("user", `gate-p2-${crypto.randomUUID()}@test`);
    const booked = await bookAs(patient.token, await futureSlot(open.id));
    expect(booked.status).toBe(201);

    const res = await api(`/api/clinic/appointments/${booked.body.id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: await futureSlot(paused.id) }),
    });
    expect(res.status).toBe(400);
  });
});

describe("выключенная учётная запись", () => {
  test("к выключенному специалисту не записаться и его времени не видно", async () => {
    const gone = await specialist("gone");
    const slotId = await futureSlot(gone.id);
    await db.update(users).set({ disabledAt: new Date().toISOString() }).where(eq(users.id, gone.id));
    const patient = await makeUser("user", `gate-p3-${crypto.randomUUID()}@test`);

    expect(await offered(patient.token, gone.id)).toEqual([]);
    expect((await bookAs(patient.token, slotId)).status).toBe(400);

    // и в списке «к кому записаться» его тоже нет
    const list = await api(`/api/clinic/specialists?departmentId=${departmentId}`, patient.token);
    expect(list.body.items.some((s: { userId: string }) => s.userId === gone.id)).toBe(false);
  });
});

describe("под боевой ролью базы", () => {
  /*
   * Проверка принимающего читает строку специалиста — а пациенту политика
   * users_read (0075) чужие строки не показывает. Сюита ходит владельцем
   * базы, который политики обходит, и не увидела бы, что проверка в бою
   * отказывает всем подряд: «специалиста нет — значит, не принимает».
   * Поэтому путь записи пациента прогоняется ещё раз отдельным процессом
   * под ролью без прав владельца (test/appRole.ts).
   */
  type Booked = { offered: number; listed: string[]; booked: number; mine: number; refused: number };

  test("пациент видит время, записывается к принимающему и видит свой приём; к неприёмному — отказ", async () => {
    const open = await specialist("rls-open");
    const paused = await specialist("rls-paused", { acceptsBookings: false });
    const slotId = await futureSlot(open.id);
    const pausedSlot = await futureSlot(paused.id);
    const patient = await makeUser("user", `gate-rls-${crypto.randomUUID()}@test`);

    const out = await underAppRole<Booked>(`
      const auth = { Authorization: ${JSON.stringify(`Bearer ${patient.token}`)}, "Content-Type": "application/json" };
      const free = await app.request(${JSON.stringify(`/api/clinic/slots?specialistId=${open.id}`)}, { headers: auth });
      out.offered = (await free.json()).items?.length ?? -1;
      const list = await app.request(${JSON.stringify(`/api/clinic/specialists?departmentId=${departmentId}`)}, { headers: auth });
      out.listed = ((await list.json()).items ?? []).map((s) => s.userId);
      const res = await app.request("/api/clinic/appointments", {
        method: "POST", headers: auth, body: JSON.stringify({ slotId: ${JSON.stringify(slotId)} }),
      });
      out.booked = res.status;
      const mine = await app.request("/api/clinic/appointments/mine", { headers: auth });
      out.mine = (await mine.json()).items?.length ?? -1;
      const refused = await app.request("/api/clinic/appointments", {
        method: "POST", headers: auth, body: JSON.stringify({ slotId: ${JSON.stringify(pausedSlot)} }),
      });
      out.refused = refused.status;
    `);
    expect(out.error, out.error).toBeUndefined();
    expect(out.rlsActive, "роль обходит политики — проверка ничего не доказывает").toBe(true);

    const [row] = await db.select().from(appointments).where(eq(appointments.slotId, slotId));
    if (row) mine.push(row.id);

    expect(out.offered, `пациенту под боевой ролью не выдано свободное время: ${JSON.stringify(out)}`).toBe(1);
    expect(out.listed, "принимающего нет в списке пациента под боевой ролью").toContain(open.id);
    expect(out.listed).not.toContain(paused.id);
    expect(out.booked, "принимающий специалист отказал пациенту под боевой ролью").toBe(201);
    expect(out.mine, "свой приём не виден пациенту под боевой ролью").toBe(1);
    expect(out.refused).toBe(400);
  }, 60_000);
});
