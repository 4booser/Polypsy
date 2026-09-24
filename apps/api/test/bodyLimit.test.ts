import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, app, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";

/**
 * Потолок на тело запроса: общий — мегабайт, для аудио приёма — свой.
 *
 * Общий лимит стоит на «*» и срабатывает раньше маршрута, поэтому проверка
 * размера внутри routes/recordings не выполнялась никогда: запись приёма
 * длиннее пары минут упиралась в 413 — молча, без строки в логе о причине.
 * Тест держит обе стороны сразу: аудио проходит, всё прочее — нет. Иначе
 * «починка» в виде поднятого общего лимита выглядела бы зелёной.
 */

const TWO_MIB = 2 * 1024 * 1024;

async function recordingInProgress() {
  const departmentId = crypto.randomUUID();
  await db.insert(departments).values({
    id: departmentId,
    title: { uk: "Відділення розміру", ru: "Отделение размера" },
    timezone: "Europe/Kyiv",
  });
  const specialist = await makeUser("admin", `big-s-${crypto.randomUUID()}@test`);
  const patient = await makeUser("user", `big-p-${crypto.randomUUID()}@test`);
  await db
    .insert(specialistProfiles)
    .values({ userId: specialist.id, departmentId })
    .onConflictDoNothing();

  const slotId = crypto.randomUUID();
  await db.insert(slots).values({
    id: slotId,
    specialistId: specialist.id,
    departmentId,
    startsAt: new Date(Date.now() + 3600_000).toISOString(),
    endsAt: new Date(Date.now() + 7200_000).toISOString(),
    kind: "any",
  });
  const id = crypto.randomUUID();
  await db.insert(appointments).values({
    id,
    slotId,
    patientId: patient.id,
    specialistId: specialist.id,
    kind: "primary",
    status: "in_progress",
  });

  await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
  await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
  return { id, specialist, patient };
}

describe("размер тела запроса", () => {
  test("запись приёма на два мегабайта загружается", async () => {
    const { id, specialist } = await recordingInProgress();

    const form = new FormData();
    form.append("audio", new File([new Uint8Array(TWO_MIB).fill(3)], "visit.wav", { type: "audio/wav" }));
    const res = await app.request(`/api/recordings/${id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${specialist.token}` },
      body: form,
    });

    expect(res.status, "часовой приём не должен упираться в общий мегабайт").toBe(200);

    // и файл действительно сохранён: 413 мог бы смениться молчаливой потерей
    const [row] = await db
      .select()
      .from(visitRecordings)
      .where(eq(visitRecordings.appointmentId, id));
    expect(row!.status).toBe("uploaded");
    expect(row!.audioBytes).toBe(TWO_MIB);
  });

  test("двухмегабайтное тело на обычный маршрут по-прежнему отвергается", async () => {
    /*
     * Вторая половина проверки. Общий потолок держит бомбу в теле: без него
     * любой маршрут можно занять разбором стомегабайтного JSON.
     */
    const res = await app.request("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "big@test.dev", password: "x".repeat(TWO_MIB) }),
    });
    expect(res.status).toBe(413);
  });
});
