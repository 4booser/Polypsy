import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { appApi, db, makeUser, type Person } from "./fixtures";
import { taggedAppRolePool } from "./appRole";
import { app as rawApp } from "../src/app";
import { runOnPool } from "../src/db";
import { appointments, auditLog, departments, googleCalendarTokens, slots, specialistProfiles } from "../src/db/schema";
import { env } from "../src/env";
import { encryptField } from "../src/lib/crypto";
import { syncDueMeetings } from "../src/lib/meetSync";

/**
 * Встреча Google при записи на приём — не под замком слота (#205).
 *
 * Прежде встреча создавалась в транзакции записи, после takeSlot: строка
 * слота стояла под замком и транзакция с соединением пула — открытыми всё
 * время обращений к Google (до 8 с на вызов, два вызова). Запись в тот же
 * слот и его правка ждали Google. Теперь запись фиксируется с меткой «ждёт
 * встречи», встречу создаёт шаг после фиксации, и ответ уходит после него.
 *
 * Google подменён локальным fetch с памятью о событиях; нужный вызов
 * «висит» до команды теста — так видно, что держит запись, пока ждёт сеть.
 * Запросы — ролью приложения; первая запись — своим пулом с именем, чтобы
 * сосчитать его открытые транзакции.
 */

const TAG = `w23bm${crypto.randomUUID().slice(0, 8)}`;
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const originalFetch = globalThis.fetch;
const saved = { id: env.googleClientId, secret: env.googleClientSecret, redirect: env.googleRedirectUri };

interface Call {
  method: string;
  url: string;
  start: string | null;
}
/** Календарь «Google»: событие и его начало */
const calendar = new Map<string, { start: string }>();
const calls: Call[] = [];
let eventSeq = 0;
const holds: { match: (call: Call) => boolean; wait: () => Promise<void> }[] = [];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = 0;
  return {
    wait: async () => {
      reached += 1;
      await opened;
    },
    reached: () => reached > 0,
    release: () => open(),
  };
}

/** Задержать первый подходящий вызов Google до команды */
function holdGoogle(match: (call: Call) => boolean) {
  const g = gate();
  let taken = false;
  holds.push({
    match: (call) => {
      if (taken || !match(call)) return false;
      taken = true;
      return true;
    },
    wait: g.wait,
  });
  return g;
}

async function google(call: Call): Promise<Response> {
  calls.push(call);
  const held = holds.find((h) => h.match(call));
  if (held) await held.wait();
  if (call.method === "POST") {
    eventSeq += 1;
    const created = `${TAG}-evt-${eventSeq}`;
    calendar.set(created, { start: call.start ?? "" });
    return Response.json({ id: created, hangoutLink: `https://meet.google.com/${created}` });
  }
  const id = decodeURIComponent(call.url.slice(EVENTS.length + 1).replace(/\?.*$/, ""));
  const event = calendar.get(id);
  if (!event) return Response.json({ error: "not found" }, { status: 404 });
  if (call.method === "DELETE") {
    calendar.delete(id);
    return new Response(null, { status: 204 });
  }
  if (call.method === "PATCH" && call.start) event.start = call.start;
  return Response.json({ id });
}

async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`не дождались: ${what}`);
}

/** Завершился ли запрос за отведённое время — не стоял ли он за чужим замком */
async function doneWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([p.then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
}

/** Соединения пула с этим именем, у которых открыта транзакция */
async function openTransactions(applicationName: string): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
     where datname = current_database() and application_name = ${applicationName} and xact_start is not null`);
  return Number(row?.n ?? 0);
}

let departmentId: string;
const mine: string[] = [];

beforeAll(async () => {
  env.googleClientId = "test-client";
  env.googleClientSecret = "test-secret";
  env.googleRedirectUri = "http://localhost/meet/callback";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "synthetic-access" });
    if (url.startsWith("https://www.googleapis.com/")) {
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { start?: { dateTime?: string } }) : null;
      return google({ method: init?.method ?? "GET", url, start: body?.start?.dateTime ?? null });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: `Зустріч поза замком ${TAG}`, ru: `Встреча вне замка ${TAG}` },
    timezone: "Europe/Kyiv",
  });
});

afterAll(async () => {
  holds.length = 0;
  globalThis.fetch = originalFetch;
  // настройки Google — назад: «вход через Google выключен, пока не настроен» проверяют соседи
  env.googleClientId = saved.id;
  env.googleClientSecret = saved.secret;
  env.googleRedirectUri = saved.redirect;
  // ничего живого в общей очереди сведения
  const left = mine.length
    ? mine
    : (await db.select({ id: appointments.id }).from(appointments).innerJoin(slots, eq(slots.id, appointments.slotId)).where(eq(slots.departmentId, departmentId))).map((r) => r.id);
  if (left.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString(), meetingSyncAt: null })
      .where(inArray(appointments.id, left));
  }
}, 15_000);

let slotSeq = 0;
async function slotFor(specialistId: string, capacity = 1) {
  slotSeq += 1;
  const start = Date.now() + 600 * 3600_000 + slotSeq * 2 * 3600_000;
  const id = crypto.randomUUID();
  const startsAt = new Date(start).toISOString();
  await db
    .insert(slots)
    .values({ id, specialistId, departmentId, startsAt, endsAt: new Date(start + 3600_000).toISOString(), capacity });
  return { id, startsAt };
}

async function specialist(tag: string): Promise<Person> {
  const person = await makeUser("admin", `${TAG}-s-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
  await db
    .insert(googleCalendarTokens)
    .values({ userId: person.id, refreshTokenEnc: encryptField(`refresh-${tag}`)!, googleEmail: `${tag}@example.test` });
  return person;
}

const appointment = async (id: string) => (await db.select().from(appointments).where(eq(appointments.id, id)))[0]!;
const ofSlot = async (slotId: string) => db.select().from(appointments).where(eq(appointments.slotId, slotId));

async function auditOf(action: string, id: string) {
  const [row] = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, id)));
  return row?.details as Record<string, unknown> | undefined;
}

/** Запись приложением напрямую — ролью приложения своего пула (runOnPool), без подмены пула в fixtures */
async function book(token: string, body: Record<string, unknown>) {
  const res = await rawApp.request("/api/clinic/appointments", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as { id: string } };
}

const createdFor = (startsAt: string) => calls.filter((c) => c.method === "POST" && c.start === startsAt).length;

describe("встреча при записи на приём — после фиксации, не под замком слота (#205)", () => {
  test("Google висит: транзакция записи закрыта, запись в тот же слот не ждёт; после ответа встреча на месте", async () => {
    const doctor = await specialist("lock");
    const slot = await slotFor(doctor.id, 2);
    const [first, second, third] = await Promise.all(
      ["a", "b", "c"].map((k) => makeUser("user", `${TAG}-p-lock-${k}-${crypto.randomUUID()}@test`)),
    );
    const appName = `${TAG}-book`;
    const pool = await taggedAppRolePool(appName);
    const g = holdGoogle((c) => c.method === "POST" && c.start === slot.startsAt);
    let booked: Awaited<ReturnType<typeof book>>;
    try {
      const pending = runOnPool(pool, () => book(first!.token, { slotId: slot.id, mode: "remote" }));
      pending.catch(() => {});
      await until(g.reached, "запись дошла до Google");

      expect(await openTransactions(appName), "запись держит транзакцию, пока ждёт Google").toBe(0);
      // запись уже зафиксирована — с меткой «ждёт встречи», срок которой впереди: фоновый проход её не берёт
      const [row] = await ofSlot(slot.id);
      expect(row?.meetingUrl).toBeNull();
      expect(Date.parse(row!.meetingSyncAt!)).toBeGreaterThan(Date.now());
      await syncDueMeetings();
      expect(createdFor(slot.startsAt), "фоновый проход создал вторую встречу").toBe(1);

      // соседняя запись в тот же слот — прежде стояла за замком слота, пока Google думал
      const neighbour = appApi("/api/clinic/appointments", second!.token, {
        method: "POST",
        body: JSON.stringify({ slotId: slot.id }),
      });
      expect(await doneWithin(neighbour, 5_000), "запись в тот же слот ждала Google").toBe(true);
      const nb = await neighbour;
      expect(nb.status, JSON.stringify(nb.body)).toBe(201);
      mine.push(nb.body.id);

      g.release();
      booked = await pending;
    } finally {
      g.release();
      await pool.close();
    }

    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    mine.push(booked.body.id);
    // ответ ушёл после шага: ссылка в приёме, метка снята, событие одно
    const after = await appointment(booked.body.id);
    expect(after.meetingEventId).not.toBeNull();
    expect(after.meetingUrl).toBe(`https://meet.google.com/${after.meetingEventId}`);
    expect(after.meetingOrganizerId).toBe(doctor.id);
    expect(after.meetingSyncAt).toBeNull();
    expect(calendar.get(after.meetingEventId!)?.start).toBe(slot.startsAt);
    expect(createdFor(slot.startsAt)).toBe(1);
    expect((await auditOf("clinic.book", booked.body.id))?.meet).toBe("pending");
    expect((await auditOf("clinic.book_meet", booked.body.id))?.meet).toBe("created");

    // положительный контроль: места в слоте считаются, как прежде, — третьему отказ
    const refused = await appApi("/api/clinic/appointments", third!.token, {
      method: "POST",
      body: JSON.stringify({ slotId: slot.id }),
    });
    expect(refused.status).toBe(400);
  }, 60_000);

  test("отмена, пока встреча создаётся: отмена не ждёт, созданное событие не остаётся сиротой", async () => {
    const doctor = await specialist("cancel");
    const slot = await slotFor(doctor.id);
    const patient = await makeUser("user", `${TAG}-p-cancel-${crypto.randomUUID()}@test`);
    const g = holdGoogle((c) => c.method === "POST" && c.start === slot.startsAt);
    let booked: { status: number; body: { id: string } };
    try {
      const pending = appApi<{ id: string }>("/api/clinic/appointments", patient.token, {
        method: "POST",
        body: JSON.stringify({ slotId: slot.id, mode: "remote" }),
      });
      pending.catch(() => {});
      await until(g.reached, "запись дошла до Google");

      const [row] = await ofSlot(slot.id);
      expect(row, "запись не зафиксирована, пока ждёт Google").toBeDefined();
      mine.push(row!.id);
      const cancel = appApi(`/api/clinic/appointments/${row!.id}/cancel`, patient.token, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(await doneWithin(cancel, 5_000), "отмена ждала Google").toBe(true);
      expect((await cancel).status).toBe(200);

      g.release();
      booked = await pending;
    } finally {
      g.release();
    }

    expect(booked.status).toBe(201);
    const after = await appointment(booked.body.id);
    expect(after.status).toBe("cancelled");
    expect(after.meetingEventId).toBeNull();
    expect(after.meetingUrl).toBeNull();
    // событие, созданное шагом для уже отменённого приёма, удалено из календаря
    expect([...calendar.values()].filter((e) => e.start === slot.startsAt)).toEqual([]);
    // метка, если осталась, сводится фоновым проходом без Google
    await syncDueMeetings(new Date(Date.now() + 60_000));
    expect((await appointment(booked.body.id)).meetingSyncAt).toBeNull();
    expect(createdFor(slot.startsAt)).toBe(1);
  }, 60_000);

  test("шаг опоздал за срок захвата: фоновый проход создал встречу сам — событие одно, приём ссылается на него", async () => {
    const doctor = await specialist("late");
    const slot = await slotFor(doctor.id);
    const patient = await makeUser("user", `${TAG}-p-late-${crypto.randomUUID()}@test`);
    const g = holdGoogle((c) => c.method === "POST" && c.start === slot.startsAt);
    let booked: { status: number; body: { id: string } };
    try {
      const pending = appApi<{ id: string }>("/api/clinic/appointments", patient.token, {
        method: "POST",
        body: JSON.stringify({ slotId: slot.id, mode: "remote" }),
      });
      pending.catch(() => {});
      await until(g.reached, "запись дошла до Google");
      const [row] = await ofSlot(slot.id);
      mine.push(row!.id);
      // срок захвата вышел (процесс «замер»): фоновый проход доделывает встречу сам
      await db
        .update(appointments)
        .set({ meetingSyncAt: new Date(Date.now() - 1000).toISOString() })
        .where(eq(appointments.id, row!.id));
      await syncDueMeetings();
      expect((await appointment(row!.id)).meetingEventId).not.toBeNull();

      g.release();
      booked = await pending;
    } finally {
      g.release();
    }

    expect(booked.status).toBe(201);
    const after = await appointment(booked.body.id);
    const live = [...calendar.entries()].filter(([, e]) => e.start === slot.startsAt).map(([id]) => id);
    expect(live, "в календаре сирота или ни одного события").toEqual([after.meetingEventId!]);
    expect(after.meetingUrl).toBe(`https://meet.google.com/${after.meetingEventId}`);
    expect(createdFor(slot.startsAt)).toBe(2);
  }, 60_000);
});
