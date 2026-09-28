import { describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { api, client, db, makeUser, root } from "./fixtures";
import { appointments, departments, patientNotes, slots, specialistProfiles } from "../src/db/schema";

/**
 * Заметка приёма привязывается только к приёму того же человека (внешний
 * разбор 2026-09-27, п. 5, P2).
 *
 * Было: PUT /api/notes/patients/:userId принимал appointmentId как есть.
 * Разрешённый сотрудник сохранял заметку пациента A с приёмом пациента B и
 * получал 200, а карточка приёма (GET /api/clinic/appointments/:id/context)
 * ищет протокол по одному appointmentId — и показывала на приёме B текст о
 * человеке A. Ошибка специалиста, открытого не на той вкладке, была бы
 * утечкой клинической записи другому пациенту и его врачу.
 *
 * Стало: маршрут сверяет принадлежность приёма, а база держит то же правило
 * составным внешним ключом (appointment_id, user_id) → appointments(id,
 * patient_id) (миграция 0110) — вход мимо маршрута так же упирается в отказ.
 *
 * Под ролью приложения (test:app-role): приём читается под политиками строк.
 */

let departmentId: string | null = null;
/** Слоты одного специалиста не пересекаются (исключение slots_open_no_overlap): у каждого свой час */
let hour = 0;

async function visitOf(patientId: string, specialistId: string): Promise<string> {
  if (!departmentId) {
    departmentId = crypto.randomUUID();
    await db.insert(departments).values({ id: departmentId, title: { uk: "Відділення", ru: "Отделение" }, timezone: "Europe/Kyiv" });
  }
  await db.insert(specialistProfiles).values({ userId: specialistId, departmentId }).onConflictDoNothing();
  const slotId = crypto.randomUUID();
  // слот в прошлом и приём завершён: в живых очередях записи ничего не оставляем
  hour += 1;
  const start = Date.now() - 86_400_000 - hour * 3_600_000;
  await db.insert(slots).values({
    id: slotId,
    specialistId,
    departmentId,
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 1800_000).toISOString(),
    kind: "any",
  });
  const id = crypto.randomUUID();
  await db.insert(appointments).values({ id, slotId, patientId, specialistId, kind: "primary", status: "done" });
  return id;
}

async function pair() {
  const tag = crypto.randomUUID().slice(0, 8);
  const specialist = await makeUser("admin", `na-s-${tag}@test`);
  const a = await makeUser("user", `na-a-${tag}@test`);
  const b = await makeUser("user", `na-b-${tag}@test`);
  return { specialist, a, b, visitA: await visitOf(a.id, specialist.id), visitB: await visitOf(b.id, specialist.id) };
}

const save = (userId: string, body: Record<string, unknown>) =>
  api(`/api/notes/patients/${userId}`, root.token, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Accept-Language": "ru" },
  });

async function latestNote(userId: string) {
  const [row] = await db
    .select()
    .from(patientNotes)
    .where(eq(patientNotes.userId, userId))
    .orderBy(desc(patientNotes.version))
    .limit(1);
  return row ?? null;
}

describe("приём заметки — приём этого же человека", () => {
  test("заметку A нельзя привязать к приёму B", async () => {
    const { a, visitB } = await pair();
    const res = await save(a.id, { text: "Запись о человеке A", kind: "session", appointmentId: visitB, baseVersion: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("другому человеку");
    expect(await latestNote(a.id), "заметка A легла с приёмом B").toBeNull();
  });

  test("несуществующий приём — «не найден», а не молчаливая ссылка в никуда", async () => {
    const { a } = await pair();
    const res = await save(a.id, { text: "Запись", appointmentId: crypto.randomUUID(), baseVersion: 0 });
    expect(res.status).toBe(404);
    expect(await latestNote(a.id)).toBeNull();
  });

  test("свой приём — как прежде: заметка становится протоколом приёма", async () => {
    const { a, visitA } = await pair();
    const res = await save(a.id, { text: "Протокол приёма A", kind: "session", appointmentId: visitA, baseVersion: 0 });
    expect(res.status).toBe(200);
    expect((await latestNote(a.id))!.appointmentId).toBe(visitA);
  });

  test("черновик не перепривязывается к чужому приёму при правке", async () => {
    const { a, visitA, visitB } = await pair();
    const first = await save(a.id, { text: "Черновик", appointmentId: visitA, baseVersion: 0 });
    expect(first.status).toBe(200);

    const moved = await save(a.id, {
      text: "Черновик, правка",
      appointmentId: visitB,
      baseVersion: first.body.current.version,
      baseRevision: first.body.current.revision,
    });
    expect(moved.status).toBe(400);
    const row = await latestNote(a.id);
    expect(row!.appointmentId).toBe(visitA);
    expect(row!.revision).toBe(first.body.current.revision);
  });

  test("карточка приёма B не показывает заметку A", async () => {
    const { a, visitB } = await pair();
    await save(a.id, { text: "Запись о человеке A", appointmentId: visitB, baseVersion: 0 });
    const context = await api(`/api/clinic/appointments/${visitB}/context`, root.token);
    expect(context.status).toBe(200);
    // карточка ищет «протокол этого приёма» по одному appointmentId: чужая заметка стала бы его протоколом
    expect(context.body.note, "протоколом приёма B стала заметка о человеке A").toBeNull();
  });
});

describe("то же правило держит база", () => {
  test("строку заметки с чужим приёмом не вставить и мимо маршрута", async () => {
    const { a, specialist, visitB } = await pair();
    let failure: unknown = null;
    try {
      await client`
        insert into patient_notes (id, user_id, version, kind, text, appointment_id, created_by)
        values (${crypto.randomUUID()}, ${a.id}, 1, 'session', 'x', ${visitB}, ${specialist.id})`;
    } catch (error) {
      failure = error;
    }
    expect(failure, "база приняла заметку A с приёмом B").not.toBeNull();
    // нарушение внешнего ключа, а не что-то постороннее
    expect((failure as { code?: string }).code).toBe("23503");
  });

  test("заметка без приёма по-прежнему законна", async () => {
    const { a, specialist } = await pair();
    await client`
      insert into patient_notes (id, user_id, version, kind, text, appointment_id, created_by)
      values (${crypto.randomUUID()}, ${a.id}, 1, 'observation', 'x', null, ${specialist.id})`;
    expect((await latestNote(a.id))!.appointmentId).toBeNull();
  });
});
