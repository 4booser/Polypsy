import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { appApi, db, makeUser, type Person } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";

/**
 * Запись разговора и перенос приёма к другому специалисту (волна 18, внешний
 * разбор, #101).
 *
 * Было: пациент открыл панель записи ещё до приёма — строка visit_recordings
 * завелась со specialist_id врача A. Приём перенесли на слот врача B. Политика
 * строк показывает запись пациенту и сохранённому в ней специалисту, то есть
 * A; врачу B строка не видна, а вторую завести нельзя (одна запись на приём),
 * и recordingFor после onConflictDoNothing падал на `rec.id` у undefined —
 * 500 у нового врача на GET и на согласии.
 *
 * Контракт теперь явный (lib/recordingTransfer.ts):
 *   — пустая запись (без согласия и материалов) переходит к новому
 *     специалисту вместе с приёмом;
 *   — данное согласие при этом снимается: оно давалось на разговор с A;
 *   — запись с материалами (идёт, аудио, стенограмма) приём к другому
 *     специалисту не отпускает — 409, разговор остаётся у того, с кем он был;
 *   — прежний специалист к новому разговору отношения не имеет.
 *
 * Всё — ролью приложения (appApi): владелец базы политик не видит, и дефект
 * сюита не ловила.
 */

let departmentId: string;
const mine: string[] = [];

beforeAll(async () => {
  departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення передачі записів", ru: "Отделение передачи записей" },
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

let seq = 0;
async function slotFor(specialistId: string): Promise<string> {
  seq += 1;
  const start = Date.now() + 300 * 3600_000 + seq * 2 * 3600_000;
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

async function specialist(tag: string): Promise<Person> {
  const person = await makeUser("admin", `rt-s-${tag}-${crypto.randomUUID()}@test`);
  await db.insert(specialistProfiles).values({ userId: person.id, departmentId });
  return person;
}

/** Будущий приём у врача A, панель записи уже открыта обеими сторонами */
async function bookedWithPanel(tag: string) {
  const a = await specialist(`${tag}-a`);
  const b = await specialist(`${tag}-b`);
  const patient = await makeUser("user", `rt-p-${tag}-${crypto.randomUUID()}@test`);
  const booked = await appApi("/api/clinic/appointments", patient.token, {
    method: "POST",
    body: JSON.stringify({ slotId: await slotFor(a.id) }),
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const id = booked.body.id as string;
  mine.push(id);
  expect((await appApi(`/api/recordings/${id}`, patient.token)).status).toBe(200);
  expect((await appApi(`/api/recordings/${id}`, a.token)).status).toBe(200);
  return { id, a, b, patient };
}

async function recordingOf(appointmentId: string) {
  const [row] = await db.select().from(visitRecordings).where(eq(visitRecordings.appointmentId, appointmentId));
  return row!;
}

describe("перенос к другому специалисту", () => {
  test("пустая запись переходит к новому врачу: GET, согласие и старт без 500; прежний врач доступ теряет", async () => {
    const { id, a, b, patient } = await bookedWithPanel("empty");
    const moved = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: await slotFor(b.id) }),
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await recordingOf(id)).specialistId).toBe(b.id);

    const seen = await appApi(`/api/recordings/${id}`, b.token);
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.status).toBe("consent_pending");

    const consent = await appApi(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    expect(consent.status, JSON.stringify(consent.body)).toBe(200);
    const started = await appApi(`/api/recordings/${id}/start`, b.token, { method: "POST" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    // прежний врач к этому разговору отношения не имеет
    expect((await appApi(`/api/recordings/${id}`, a.token)).status).toBe(404);
    expect((await appApi(`/api/recordings/${id}/stop`, a.token, { method: "POST" })).status).toBe(404);
    expect((await appApi(`/api/recordings/${id}`, patient.token)).status).toBe(200);
  });

  test("согласие, данное на разговор с прежним врачом, снимается", async () => {
    const { id, b, patient } = await bookedWithPanel("consented");
    expect((await appApi(`/api/recordings/${id}/consent`, patient.token, { method: "POST" })).status).toBe(200);

    const moved = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: await slotFor(b.id) }),
    });
    expect(moved.status).toBe(200);

    const row = await recordingOf(id);
    expect(row.specialistId).toBe(b.id);
    expect(row.consentAt).toBeNull();
    expect(row.status).toBe("consent_pending");
    // без нового согласия новый врач запись не начинает
    expect((await appApi(`/api/recordings/${id}/start`, b.token, { method: "POST" })).status).toBe(403);
    const seen = await appApi(`/api/recordings/${id}`, b.token);
    expect(seen.status).toBe(200);
    expect(seen.body.consentAt).toBeNull();
  });

  test("идущая запись приём к другому врачу не отпускает; к тому же врачу — переносится", async () => {
    const { id, a, b, patient } = await bookedWithPanel("recording");
    expect((await appApi(`/api/recordings/${id}/consent`, patient.token, { method: "POST" })).status).toBe(200);
    expect((await appApi(`/api/recordings/${id}/start`, a.token, { method: "POST" })).status).toBe(200);

    const refused = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: await slotFor(b.id) }),
    });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toContain("запис");
    const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
    expect(row!.specialistId).toBe(a.id);
    expect((await recordingOf(id)).status).toBe("recording");

    const sameDoctor = await appApi(`/api/clinic/appointments/${id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: await slotFor(a.id) }),
    });
    expect(sameDoctor.status).toBe(200);
    expect((await recordingOf(id)).specialistId).toBe(a.id);
    expect((await recordingOf(id)).status).toBe("recording");
  });

  test("без открытой панели переносится как раньше, и новый врач заводит запись сам", async () => {
    const a = await specialist("fresh-a");
    const b = await specialist("fresh-b");
    const patient = await makeUser("user", `rt-p-fresh-${crypto.randomUUID()}@test`);
    const booked = await appApi("/api/clinic/appointments", patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: await slotFor(a.id) }),
    });
    expect(booked.status).toBe(201);
    mine.push(booked.body.id);
    const moved = await appApi(`/api/clinic/appointments/${booked.body.id}/reschedule`, patient.token, {
      method: "POST",
      body: JSON.stringify({ slotId: await slotFor(b.id) }),
    });
    expect(moved.status).toBe(200);
    const seen = await appApi(`/api/recordings/${booked.body.id}`, b.token);
    expect(seen.status).toBe(200);
    expect((await recordingOf(booked.body.id)).specialistId).toBe(b.id);
  });
});
