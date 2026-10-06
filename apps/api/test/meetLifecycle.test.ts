import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import { appApi, db, makeUser, type Person } from "./fixtures";
import { appointments, auditLog, departments, googleCalendarTokens, slots, specialistProfiles } from "../src/db/schema";
import { env } from "../src/env";
import { encryptField } from "../src/lib/crypto";
import { syncDueMeetings } from "../src/lib/meetSync";

/**
 * Событие Google Calendar живёт вместе с приёмом (волна 18, внешний разбор,
 * #37).
 *
 * Было: при записи сохранялась одна ссылка Meet, без идентификатора события.
 * Перенос менял слот и специалиста, отмена — статус, а событие в календаре
 * оставалось прежним: у врача стояла встреча на снятое время, у нового врача
 * её не было, отменённый приём висел живым. Проба ревьюера: после переноса и
 * отмены — ни одного нового обращения к Google, среди операций Calendar
 * только POST.
 *
 * Google подменён локальным fetch, как в meetBooking.test.ts: записывается
 * метод и адрес каждого обращения. Запросы — ролью приложения (appApi).
 */

let departmentId: string;
const mine: string[] = [];
const saved = { id: env.googleClientId, secret: env.googleClientSecret, redirect: env.googleRedirectUri };
const originalFetch = globalThis.fetch;

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}
const calls: Call[] = [];
/** Что Google «ответит» на операцию над событиями; токен выдаётся всегда */
let events: (call: Call) => Promise<Response> = async () => new Response("unset", { status: 500 });
let eventSeq = 0;

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const meetOf = (id: string) => `https://meet.google.com/${id}`;

/** Исправный Google: создаёт события с нарастающими номерами, переносит и удаляет */
function googleOk(): (call: Call) => Promise<Response> {
  return async (call) => {
    if (call.method === "POST") {
      eventSeq += 1;
      return Response.json({ id: `evt-${eventSeq}`, hangoutLink: meetOf(`evt-${eventSeq}`) });
    }
    if (call.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json({ id: call.url.slice(call.url.lastIndexOf("/") + 1) });
  };
}

const calendarCalls = () => calls.filter((c) => c.url.startsWith(EVENTS));
const brief = (c: Call) => `${c.method} ${c.url.replace(EVENTS, "events").replace(/\?.*$/, "")}`;

beforeAll(async () => {
  env.googleClientId = "test-client";
  env.googleClientSecret = "test-secret";
  env.googleRedirectUri = "http://localhost/meet/callback";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      calls.push({ method: "POST", url, body: null });
      return Response.json({ access_token: "synthetic-access" });
    }
    if (url.startsWith("https://www.googleapis.com/")) {
      const call: Call = {
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      return events(call);
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Дистанційний прийом: календар", ru: "Дистанционный приём: календарь" },
    timezone: "Europe/Kyiv",
  });
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  env.googleClientId = saved.id;
  env.googleClientSecret = saved.secret;
  env.googleRedirectUri = saved.redirect;
  if (mine.length) {
    await db
      .update(appointments)
      .set({ status: "cancelled", cancelledAt: new Date().toISOString(), meetingSyncAt: null })
      .where(inArray(appointments.id, mine));
  }
});

let seq = 0;
/** Свободный слот специалиста в будущем — у каждого своё время (слоты не пересекаются) */
async function slotFor(specialistId: string) {
  seq += 1;
  const start = Date.now() + 240 * 3600_000 + seq * 2 * 3600_000;
  const id = crypto.randomUUID();
  const startsAt = new Date(start).toISOString();
  const endsAt = new Date(start + 3600_000).toISOString();
  await db.insert(slots).values({ id, specialistId, departmentId, startsAt, endsAt });
  return { id, startsAt, endsAt };
}

async function specialist(tag: string, withCalendar: boolean): Promise<Person> {
  const person = await makeUser("admin", `mlc-s-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
  if (withCalendar) {
    await db
      .insert(googleCalendarTokens)
      .values({ userId: person.id, refreshTokenEnc: encryptField(`refresh-${tag}`)!, googleEmail: `${tag}@example.test` });
  }
  return person;
}

/** Дистанционный приём с событием в календаре специалиста */
async function remoteVisit(tag: string) {
  const doctor = await specialist(tag, true);
  const patient = await makeUser("user", `mlc-p-${tag}-${crypto.randomUUID()}@test`);
  const slot = await slotFor(doctor.id);
  events = googleOk();
  const res = await appApi("/api/clinic/appointments", patient.token, {
    method: "POST",
    body: JSON.stringify({ slotId: slot.id, mode: "remote" }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  mine.push(res.body.id);
  const row = await appointment(res.body.id);
  expect(row.meetingEventId).toMatch(/^evt-/);
  expect(row.meetingOrganizerId).toBe(doctor.id);
  calls.length = 0;
  return { id: res.body.id as string, doctor, patient, slot, row };
}

async function appointment(id: string) {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
  return row!;
}

async function auditDetails(action: string, id: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, id)));
  return row?.details as Record<string, unknown> | undefined;
}

describe("перенос", () => {
  test("к тому же специалисту — событие переезжает на новое время", async () => {
    const { id, doctor, patient, row } = await remoteVisit("move");
    const next = await slotFor(doctor.id);

    const res = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: next.id }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(calendarCalls().map(brief)).toEqual([`PATCH events/${row.meetingEventId}`]);
    expect(calendarCalls()[0]!.body).toEqual({ start: { dateTime: next.startsAt }, end: { dateTime: next.endsAt } });

    const after = await appointment(id);
    expect(after.meetingEventId).toBe(row.meetingEventId);
    expect(after.meetingOrganizerId).toBe(doctor.id);
    expect(after.meetingUrl).toBe(row.meetingUrl);
    expect(after.meetingSyncAt).toBeNull();
    expect((await auditDetails("clinic.reschedule", id))?.meet).toBe("moved");
  });

  test("к другому специалисту с календарём — событие удаляется у прежнего и создаётся у нового", async () => {
    const { id, patient, row } = await remoteVisit("switch");
    const other = await specialist("switch-to", true);
    const next = await slotFor(other.id);

    const res = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: next.id }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(calendarCalls().map(brief)).toEqual([`DELETE events/${row.meetingEventId}`, "POST events"]);
    // новое событие — на время нового слота
    expect(calendarCalls()[1]!.body).toMatchObject({ start: { dateTime: next.startsAt }, end: { dateTime: next.endsAt } });

    const after = await appointment(id);
    expect(after.specialistId).toBe(other.id);
    expect(after.meetingOrganizerId).toBe(other.id);
    expect(after.meetingEventId).not.toBe(row.meetingEventId);
    expect(after.meetingUrl).toBe(meetOf(after.meetingEventId!));
    expect(after.meetingSyncAt).toBeNull();
    expect((await auditDetails("clinic.reschedule", id))?.meet).toBe("recreated");
  });

  test("к специалисту без календаря — прежнее событие удаляется, ссылки нет", async () => {
    const { id, patient, row } = await remoteVisit("nocal");
    const other = await specialist("nocal-to", false);
    const next = await slotFor(other.id);

    const res = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: next.id }),
    });
    expect(res.status).toBe(200);
    expect(calendarCalls().map(brief)).toEqual([`DELETE events/${row.meetingEventId}`]);

    const after = await appointment(id);
    expect(after.meetingUrl).toBeNull();
    expect(after.meetingEventId).toBeNull();
    expect(after.meetingOrganizerId).toBeNull();
    expect((await auditDetails("clinic.reschedule", id))?.meet).toBe("unlinked");
  });

  test("ссылку, вписанную руками, перенос не трогает", async () => {
    const doctor = await specialist("manual", true);
    const patient = await makeUser("user", `mlc-p-manual-${crypto.randomUUID()}@test`);
    const slot = await slotFor(doctor.id);
    const url = "https://example.test/own-room";
    const booked = await appApi("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: slot.id, mode: "remote", meetingUrl: url }),
    });
    expect(booked.status).toBe(201);
    mine.push(booked.body.id);
    calls.length = 0;

    const next = await slotFor(doctor.id);
    const res = await appApi(`/api/clinic/appointments/${booked.body.id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: next.id }),
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
    expect((await appointment(booked.body.id)).meetingUrl).toBe(url);
  });
});

describe("отмена", () => {
  test("событие удаляется из календаря", async () => {
    const { id, patient, row } = await remoteVisit("cancel");
    const res = await appApi(`/api/clinic/appointments/${id}/cancel`, patient.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(calendarCalls().map(brief)).toEqual([`DELETE events/${row.meetingEventId}`]);

    const after = await appointment(id);
    expect(after.status).toBe("cancelled");
    expect(after.meetingEventId).toBeNull();
    expect(after.meetingSyncAt).toBeNull();
    expect((await auditDetails("clinic.cancel", id))?.meet).toBe("deleted");
  });

  test("событие, которого в календаре уже нет, считается удалённым", async () => {
    const { id, patient } = await remoteVisit("gone");
    events = async () => Response.json({ error: "not found" }, { status: 404 });
    const res = await appApi(`/api/clinic/appointments/${id}/cancel`, patient.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const after = await appointment(id);
    expect(after.meetingEventId).toBeNull();
    expect(after.meetingSyncAt).toBeNull();
  });
});

describe("сбой Google", () => {
  test("отмена проходит, операция сохраняется и доводится фоновым проходом — без дубликатов", async () => {
    const { id, patient, row } = await remoteVisit("retry-cancel");
    events = async () => {
      throw new TypeError("simulated calendar connection reset");
    };
    const res = await appApi(`/api/clinic/appointments/${id}/cancel`, patient.token, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(calendarCalls().map(brief)).toEqual([`DELETE events/${row.meetingEventId}`]);
    expect((await auditDetails("clinic.cancel", id))?.meet).toBe("failed");

    // операция не потеряна: событие помнится, повтор назначен
    const pending = await appointment(id);
    expect(pending.status).toBe("cancelled");
    expect(pending.meetingEventId).toBe(row.meetingEventId);
    expect(pending.meetingSyncAt).not.toBeNull();
    expect(pending.meetingSyncAttempts).toBe(1);

    // рано — проход её не трогает
    calls.length = 0;
    expect((await syncDueMeetings(new Date())).attempted).toBe(0);
    expect(calls).toEqual([]);

    // срок повтора настал, Google ожил
    events = googleOk();
    const result = await syncDueMeetings(new Date(Date.now() + 3600_000));
    expect(result).toEqual({ attempted: 1, settled: 1 });
    expect(calendarCalls().map(brief)).toEqual([`DELETE events/${row.meetingEventId}`]);

    const after = await appointment(id);
    expect(after.meetingEventId).toBeNull();
    expect(after.meetingSyncAt).toBeNull();
    expect(after.meetingSyncAttempts).toBe(0);
  });

  test("перенос к другому специалисту: сбой после удаления прежнего события не удаляет и не создаёт его дважды", async () => {
    const { id, patient, row } = await remoteVisit("retry-switch");
    const other = await specialist("retry-switch-to", true);
    const next = await slotFor(other.id);
    events = async (call) => {
      if (call.method === "DELETE") return new Response(null, { status: 204 });
      throw new TypeError("simulated calendar connection reset on create");
    };

    const res = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: next.id }),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(calendarCalls().map(brief)).toEqual([`DELETE events/${row.meetingEventId}`, "POST events"]);

    const pending = await appointment(id);
    expect(pending.specialistId).toBe(other.id);
    // прежнее событие уже убрано и из календаря, и из строки; новое ещё не создано
    expect(pending.meetingEventId).toBeNull();
    expect(pending.meetingUrl).toBeNull();
    expect(pending.meetingSyncAt).not.toBeNull();

    calls.length = 0;
    events = googleOk();
    expect((await syncDueMeetings(new Date(Date.now() + 3600_000))).settled).toBe(1);
    // только создание — прежнее удалять второй раз не нужно
    expect(calendarCalls().map(brief)).toEqual(["POST events"]);

    const after = await appointment(id);
    expect(after.meetingOrganizerId).toBe(other.id);
    expect(after.meetingEventId).toMatch(/^evt-/);
    expect(after.meetingUrl).toBe(meetOf(after.meetingEventId!));
    expect(after.meetingSyncAt).toBeNull();
  });
});
