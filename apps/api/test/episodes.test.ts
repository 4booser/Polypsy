import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { adminA, api, app, db, makeUser, submitSurvey, surveyInA } from "./fixtures";
import { appointments, departments, episodes, slots, specialistProfiles } from "../src/db/schema";

/**
 * Эпизод обслуживания.
 *
 * Приёмы, прохождения, заключения и направления лежали рядом, но не были
 * связаны: чтобы понять, «с чем человек приходил в марте и чем это
 * кончилось», приходилось складывать хронологию в голове.
 */

let departmentId: string;

async function patientOf(tag: string) {
  const person = await makeUser("user", `ep-${tag}-${crypto.randomUUID()}@test`);
  // делаем его своим для adminA: обращение открывают тому, кто в зоне
  await submitSurvey(surveyInA, person.token);
  return person;
}

async function visitFor(patientId: string) {
  if (!departmentId) {
    departmentId = crypto.randomUUID();
    await db.insert(departments).values({
      id: departmentId,
      title: { uk: "Відділення", ru: "Отделение" },
      timezone: "Europe/Kyiv",
    });
    await db
      .insert(specialistProfiles)
      .values({ userId: adminA.id, departmentId })
      .onConflictDoNothing();
  }
  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId: adminA.id,
    departmentId,
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 90_000_000).toISOString(),
    kind: "any",
  });
  const id = crypto.randomUUID();
  await db.insert(appointments).values({
    id,
    slotId,
    patientId,
    specialistId: adminA.id,
    kind: "primary",
    status: "done",
  });
  return id;
}

describe("обращение", () => {
  test("открывается с поводом словами и виден счётчик приёмов", async () => {
    const person = await patientOf("a");
    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id, reason: "После командировки не спит" }),
    });
    expect(opened.status).toBe(201);

    const visitId = await visitFor(person.id);
    const attached = await api(
      `/api/episodes/${opened.body.id}/appointments/${visitId}`,
      adminA.token,
      { method: "POST" },
    );
    expect(attached.status).toBe(200);

    const list = await api(`/api/episodes/patients/${person.id}`, adminA.token);
    const mine = list.body.items.find((e: { id: string }) => e.id === opened.body.id);
    expect(mine.reason).toBe("После командировки не спит");
    expect(mine.visits).toBe(1);
  });

  test("повод хранится зашифрованным", async () => {
    const person = await patientOf("b");
    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id, reason: "Уникальное слово фазаньев" }),
    });
    const [row] = await db.select().from(episodes).where(eq(episodes.id, opened.body.id));
    expect(row!.reasonEnc).not.toContain("фазаньев");
  });

  test("два открытых обращения на человека не заводятся", async () => {
    /*
     * Два одновременных обращения — это не два обращения, а потерянная связь
     * между событиями: непонятно, к какому из них относится сегодняшний
     * приём.
     */
    const person = await patientOf("c");
    const first = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id }),
    });
    expect(first.status).toBe(201);

    const second = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id }),
    });
    expect(second.status).toBe(400);
  });

  test("закрытое освобождает место новому", async () => {
    const person = await patientOf("d");
    const first = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id }),
    });
    const closed = await api(`/api/episodes/${first.body.id}/close`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ outcomeKind: "improved", outcome: "Сон восстановился" }),
    });
    expect(closed.status).toBe(200);

    const second = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id }),
    });
    expect(second.status).toBe(201);
  });

  test("повторное закрытие отклоняется", async () => {
    const person = await patientOf("e");
    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id }),
    });
    await api(`/api/episodes/${opened.body.id}/close`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ outcomeKind: "stable" }),
    });
    const again = await api(`/api/episodes/${opened.body.id}/close`, adminA.token, {
      method: "POST",
      body: JSON.stringify({ outcomeKind: "stable" }),
    });
    expect(again.status).toBe(400);
  });

  test("чужой приём к обращению не привязать", async () => {
    const one = await patientOf("f");
    const other = await patientOf("g");
    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: one.id }),
    });
    const foreignVisit = await visitFor(other.id);

    const res = await api(
      `/api/episodes/${opened.body.id}/appointments/${foreignVisit}`,
      adminA.token,
      { method: "POST" },
    );
    expect(res.status).toBe(400);
  });
});

describe("выписка", () => {
  test("собирает приёмы и повод на один лист", async () => {
    /*
     * То, ради чего эпизод и заводился: одно обращение целиком, от повода до
     * исхода. Раньше это собирали из четырёх экранов.
     */
    const person = await patientOf("h");
    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id, reason: "Направлен командиром" }),
    });
    const visitId = await visitFor(person.id);
    await api(`/api/episodes/${opened.body.id}/appointments/${visitId}`, adminA.token, {
      method: "POST",
    });

    const res = await app.request(`/api/reports/episodes/${opened.body.id}`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Витяг за зверненням");
    expect(html).toContain("Направлен командиром");
  });

  test("черновик заключения в выписку не попадает", async () => {
    /*
     * Черновик — мысль вслух, и подшитый в дело он потом не отличается от
     * решения.
     */
    const person = await patientOf("i");
    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id }),
    });
    const submitted = await submitSurvey(surveyInA, person.token);
    await api(`/api/conclusions/responses/${submitted.body.id}/conclusion`, adminA.token, {
      method: "PUT",
      body: JSON.stringify({ text: "ЧЕРНОВИК не для дела", baseVersion: 0 }),
    });
    const { conclusions } = await import("../src/db/schema");
    await db
      .update(conclusions)
      .set({ episodeId: opened.body.id })
      .where(eq(conclusions.responseId, submitted.body.id));

    const res = await app.request(`/api/reports/episodes/${opened.body.id}`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    const html = await res.text();
    expect(html).not.toContain("ЧЕРНОВИК не для дела");
  });
});
