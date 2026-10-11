import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { appApi, db, makeUser, type Person } from "./fixtures";
import { appointments, departments, googleCalendarTokens, slots, specialistProfiles } from "../src/db/schema";
import { env } from "../src/env";
import { encryptField } from "../src/lib/crypto";
import { syncDueMeetings } from "../src/lib/meetSync";
import { queuedOrDone } from "./lockQueue";

/**
 * Сведение Google Calendar без захвата строки приёма (#152).
 *
 * Фоновый проход (syncDueMeetings) и сведение из запроса читали приём без
 * замка, ходили в Google и записывали итог по id. Два прохода над приёмом,
 * ждущим пересоздания встречи, создавали два события: приём ссылался на
 * одно, второе оставалось сиротой в календаре врача. Проход, наложившийся на
 * перенос, затирал своим итогом событие, которое только что создал запрос.
 *
 * Google подменён локальным fetch с памятью о событиях (как в
 * meetLifecycle.test.ts, но события живут и умирают): видно, сколько их
 * создано и на какое ссылается приём. Нужный вызов «зависает» до команды —
 * так одна сторона гонки держит строку, пока другая приходит. Запросы
 * пациента — ролью приложения (appApi).
 */

let departmentId: string;
const mine: string[] = [];
const saved = { id: env.googleClientId, secret: env.googleClientSecret, redirect: env.googleRedirectUri };
const originalFetch = globalThis.fetch;

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const meetOf = (id: string) => `https://meet.google.com/${id}`;

interface Call {
  method: string;
  url: string;
}
const calls: Call[] = [];
/** События, которые сейчас есть в календаре «Google» */
const live = new Set<string>();
let eventSeq = 0;
/** Вызов, который ждёт команды, — одна сторона гонки «в сети» */
let hold: ((call: Call) => Promise<void>) | null = null;

/** Задержать ответ Google на первый вызов этим методом, пока не отпустят */
function gate(method: string) {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let reached = false;
  hold = async (call) => {
    if (call.method !== method || reached) return;
    reached = true;
    await opened;
  };
  return {
    reached: () => reached,
    release: () => {
      hold = null;
      open();
    },
  };
}

async function google(call: Call): Promise<Response> {
  if (hold) await hold(call);
  const id = decodeURIComponent(call.url.slice(EVENTS.length + 1).replace(/\?.*$/, ""));
  if (call.method === "POST") {
    eventSeq += 1;
    const created = `race-evt-${eventSeq}`;
    live.add(created);
    return Response.json({ id: created, hangoutLink: meetOf(created) });
  }
  if (!live.has(id)) return Response.json({ error: "not found" }, { status: 404 });
  if (call.method === "DELETE") {
    live.delete(id);
    return new Response(null, { status: 204 });
  }
  return Response.json({ id });
}

const created = () => calls.filter((c) => c.method === "POST" && c.url.startsWith(EVENTS)).length;

async function until(check: () => boolean, what: string, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`не дождались: ${what}`);
}

beforeAll(async () => {
  env.googleClientId = "test-client";
  env.googleClientSecret = "test-secret";
  env.googleRedirectUri = "http://localhost/meet/callback";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "synthetic-access" });
    if (url.startsWith("https://www.googleapis.com/")) {
      const call: Call = { method: init?.method ?? "GET", url };
      calls.push(call);
      return google(call);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Дистанційний прийом: гонка календаря", ru: "Дистанционный приём: гонка календаря" },
    timezone: "Europe/Kyiv",
  });
});

afterAll(async () => {
  hold = null;
  globalThis.fetch = originalFetch;
  env.googleClientId = saved.id;
  env.googleClientSecret = saved.secret;
  env.googleRedirectUri = saved.redirect;
  // ничего живого в общей очереди сведения
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString(), meetingSyncAt: null })
      .where(inArray(appointments.id, mine));
  }
}, 15_000);

let seq = 0;
async function slotFor(specialistId: string) {
  seq += 1;
  const start = Date.now() + 300 * 3600_000 + seq * 2 * 3600_000;
  const id = crypto.randomUUID();
  const startsAt = new Date(start).toISOString();
  const endsAt = new Date(start + 3600_000).toISOString();
  await db.insert(slots).values({ id, specialistId, departmentId, startsAt, endsAt });
  return { id, startsAt, endsAt };
}

async function specialist(tag: string): Promise<Person> {
  const person = await makeUser("admin", `msr-s-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
  await db
    .insert(googleCalendarTokens)
    .values({ userId: person.id, refreshTokenEnc: encryptField(`refresh-${tag}`)!, googleEmail: `${tag}@example.test` });
  return person;
}

/** Дистанционный приём с событием в календаре врача */
async function remoteVisit(tag: string) {
  const doctor = await specialist(tag);
  const patient = await makeUser("user", `msr-p-${tag}-${crypto.randomUUID()}@test`);
  const slot = await slotFor(doctor.id);
  const res = await appApi("/api/clinic/appointments", patient.token, {
    method: "POST",
    body: JSON.stringify({ slotId: slot.id, mode: "remote" }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  mine.push(res.body.id);
  const row = await appointment(res.body.id);
  expect(live.has(row.meetingEventId!)).toBe(true);
  return { id: res.body.id as string, doctor, patient, row };
}

async function appointment(id: string) {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
  return row!;
}

/** Приём ссылается на живое событие, и других событий у него не появилось */
async function expectOneLiveEvent(id: string, before: Set<string>) {
  const row = await appointment(id);
  const fresh = [...live].filter((e) => !before.has(e));
  expect(fresh, "в календаре осталось событие-сирота или не осталось ни одного").toEqual([row.meetingEventId!]);
  expect(row.meetingUrl).toBe(meetOf(row.meetingEventId!));
  expect(row.meetingSyncAt).toBeNull();
}

const later = () => new Date(Date.now() + 3600_000);

describe("два фоновых прохода над приёмом, ждущим пересоздания встречи", () => {
  test("одно событие, приём ссылается на него", async () => {
    const { id, row } = await remoteVisit("two-passes");
    // прежнее событие удалено и убрано из строки, новое не создано — сбой на середине пересоздания
    live.delete(row.meetingEventId!);
    await db
      .update(appointments)
      .set({ meetingEventId: null, meetingOrganizerId: null, meetingUrl: null, meetingSyncAt: new Date().toISOString() })
      .where(eq(appointments.id, id));
    const before = new Set(live);
    calls.length = 0;

    const g = gate("POST");
    const first = syncDueMeetings(later());
    first.catch(() => {});
    await until(g.reached, "первый проход дошёл до создания события");
    // второй проход: прежде — второе создание (и оно тоже повисает), теперь — пропуск занятой строки
    const second = syncDueMeetings(later());
    second.catch(() => {});
    await until(() => created() >= 2 || Bun.peek.status(second) !== "pending", "второй проход либо создал событие, либо вышел");
    g.release();
    const [a, b] = await Promise.all([first, second]);

    expect(created(), "два прохода создали два события").toBe(1);
    expect(a.settled + b.settled).toBe(1);
    await expectOneLiveEvent(id, before);
  }, 30_000);
});

describe("фоновый проход и перенос к другому врачу", () => {
  /** Приём со сведением, отложенным прежним сбоем: перенос к тому же врачу не дошёл до Google */
  async function pendingMove(tag: string) {
    const visit = await remoteVisit(tag);
    await db
      .update(appointments)
      .set({ meetingSyncAt: new Date(Date.now() - 60_000).toISOString(), meetingSyncAttempts: 1 })
      .where(eq(appointments.id, visit.id));
    return visit;
  }

  const reschedule = (id: string, token: string, slotId: string) =>
    appApi(`/api/clinic/appointments/${id}/reschedule`, token, { method: "POST", body: JSON.stringify({ slotId }) });

  test("перенос раньше прохода: проход не затирает событие, созданное переносом", async () => {
    const { id, patient, row } = await pendingMove("request-first");
    const other = await specialist("request-first-to");
    const next = await slotFor(other.id);
    const before = new Set(live);
    before.delete(row.meetingEventId!);
    calls.length = 0;

    // перенос удалил прежнее событие и создаёт новое — Google «думает»
    const g = gate("POST");
    const moved = reschedule(id, patient.token, next.id);
    moved.catch(() => {});
    await until(g.reached, "перенос дошёл до создания события");
    const tick = syncDueMeetings(later());
    tick.catch(() => {});
    // прежде проход вставал с итогом за строкой переноса; теперь пропускает её
    await queuedOrDone(tick, 1, ['update "appointments"']);
    g.release();
    const res = await moved;
    await tick;

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await appointment(id);
    expect(after.specialistId).toBe(other.id);
    expect(after.meetingOrganizerId).toBe(other.id);
    await expectOneLiveEvent(id, before);
  }, 30_000);

  test("проход раньше переноса: перенос ждёт его и сводит календарь уже после", async () => {
    const { id, patient, row } = await pendingMove("tick-first");
    const other = await specialist("tick-first-to");
    const next = await slotFor(other.id);
    const before = new Set(live);
    before.delete(row.meetingEventId!);
    calls.length = 0;

    // проход доводит отложенный перенос события — Google «думает»
    const g = gate("PATCH");
    const tick = syncDueMeetings(later());
    tick.catch(() => {});
    await until(g.reached, "проход дошёл до переноса события");
    const moved = reschedule(id, patient.token, next.id);
    moved.catch(() => {});
    // прежде перенос проходил целиком мимо прохода; теперь ждёт строку
    await queuedOrDone(moved, 1, ['update "appointments"']);
    g.release();
    await tick;
    const res = await moved;

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await appointment(id);
    expect(after.specialistId).toBe(other.id);
    expect(after.meetingOrganizerId).toBe(other.id);
    expect(live.has(row.meetingEventId!), "событие прежнего врача осталось").toBe(false);
    await expectOneLiveEvent(id, before);
  }, 30_000);
});
