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

describe("диспансерный учёт", () => {
  test("срок считается от постановки и попадает в очередь при просрочке", async () => {
    /*
     * Учёт держали в голове и в бумажном журнале — и теряли: просрочка не
     * была видна никому, пока кто-нибудь случайно не вспомнит.
     */
    const person = await patientOf("d1");
    const put = await api("/api/episodes/dispensary", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ patientId: person.id, groupLabel: "Д-II", intervalMonths: 3 }),
    });
    expect(put.status).toBe(200);

    const state = await api(`/api/episodes/dispensary/${person.id}`, adminA.token);
    expect(state.body.on).toBe(true);
    expect(state.body.groupLabel).toBe("Д-II");
    expect(state.body.overdueDays).toBe(0);

    // отодвигаем срок в прошлое и смотрим очередь
    const { dispensary } = await import("../src/db/schema");
    await db
      .update(dispensary)
      .set({ nextDueAt: new Date(Date.now() - 10 * 86_400_000).toISOString() })
      .where(eq(dispensary.patientId, person.id));

    const work = await api("/api/worklist", adminA.token);
    const item = work.body.items.find(
      (i: { kind: string; userId: string }) => i.kind === "dispensary" && i.userId === person.id,
    );
    expect(item).toBeDefined();
    expect(item.days).toBeGreaterThanOrEqual(9);
  });

  test("осмотр отмечается отдельно и отодвигает срок", async () => {
    /*
     * Отдельным действием, а не автоматически по любому приёму: человек мог
     * прийти по другому поводу, и засчитать это значило бы отодвинуть срок,
     * ничего не проверив.
     */
    const person = await patientOf("d2");
    await api("/api/episodes/dispensary", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ patientId: person.id, groupLabel: "Д-I", intervalMonths: 1 }),
    });
    const { dispensary } = await import("../src/db/schema");
    await db
      .update(dispensary)
      .set({ nextDueAt: new Date(Date.now() - 86_400_000).toISOString() })
      .where(eq(dispensary.patientId, person.id));

    const seen = await api(`/api/episodes/dispensary/${person.id}/seen`, adminA.token, {
      method: "POST",
    });
    expect(seen.status).toBe(200);

    const state = await api(`/api/episodes/dispensary/${person.id}`, adminA.token);
    expect(state.body.overdueDays).toBe(0);
    expect(state.body.lastSeenAt).not.toBeNull();
  });

  test("снятие оставляет след, а не стирает запись", async () => {
    const person = await patientOf("d3");
    await api("/api/episodes/dispensary", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ patientId: person.id, groupLabel: "Д-III", intervalMonths: 6 }),
    });
    await api(`/api/episodes/dispensary/${person.id}`, adminA.token, { method: "DELETE" });

    const state = await api(`/api/episodes/dispensary/${person.id}`, adminA.token);
    expect(state.body.on).toBe(false);

    const { dispensary } = await import("../src/db/schema");
    const [row] = await db
      .select()
      .from(dispensary)
      .where(eq(dispensary.patientId, person.id));
    expect(row).toBeDefined();
    expect(row!.removedAt).not.toBeNull();
    expect(row!.removedBy).toBe(adminA.id);
  });

  test("возврат на учёт не заводит вторую запись", async () => {
    const person = await patientOf("d4");
    await api("/api/episodes/dispensary", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ patientId: person.id, groupLabel: "Д-I", intervalMonths: 3 }),
    });
    await api(`/api/episodes/dispensary/${person.id}`, adminA.token, { method: "DELETE" });
    const back = await api("/api/episodes/dispensary", adminA.token, {
      method: "PUT",
      body: JSON.stringify({ patientId: person.id, groupLabel: "Д-II", intervalMonths: 12 }),
    });
    expect(back.status).toBe(200);

    const state = await api(`/api/episodes/dispensary/${person.id}`, adminA.token);
    expect(state.body.on).toBe(true);
    expect(state.body.groupLabel).toBe("Д-II");
  });
});

describe("амбулаторная карта", () => {
  test("собирает обращения, приёмы и обследования на один лист", async () => {
    /*
     * Человек был разложен по трём экранам: динамика, сводка, хронология. Это
     * удобно с монитора и бесполезно, когда карту надо подшить или показать
     * на разборе.
     */
    const person = await patientOf("ch");
    const opened = await api("/api/episodes", adminA.token, {
      method: "POST",
      body: JSON.stringify({ patientId: person.id, reason: "Плохо спит после выезда" }),
    });
    const visitId = await visitFor(person.id);
    await api(`/api/episodes/${opened.body.id}/appointments/${visitId}`, adminA.token, {
      method: "POST",
    });

    const res = await app.request(`/api/reports/patients/${person.id}/chart`, {
      headers: { Authorization: `Bearer ${adminA.token}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Амбулаторна карта");
    expect(html).toContain("Плохо спит после выезда");
    // обследование из фикстуры тоже на месте
    expect(html).toContain("Обстеження");
  });

  test("карту под кодом не выписать", async () => {
    // «Респондент А-4821» — не документ, как и в справке
    const coded = await makeUser("user", `ch-anon-${crypto.randomUUID()}@test`, {
      anonymous: true,
      pseudonym: "А-0001",
    });
    await submitSurvey(surveyInA, coded.token);
    const res = await api(`/api/reports/patients/${coded.id}/chart`, adminA.token);
    expect(res.status).toBe(400);
  });
});
