import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { api, app, client, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";
import { setTranscriberForTests, storeAudio, transcribeNext } from "../src/lib/recordings";
import { env } from "../src/env";

/**
 * Удалённая запись приёма не возвращается к жизни.
 *
 * Между чтением строки и её обновлением у обоих путей лежит долгая работа:
 * у остановки — приём файла на десятки мегабайт, у расшифровки — минуты
 * работы модели. Ровно в этот промежуток человек и нажимает «удалить»: он
 * сказал лишнее и забирает сказанное назад. Безусловный UPDATE возвращал
 * запись обратно — со статусом, файлом и дальнейшей расшифровкой, — и на
 * экране не оставалось ни следа того, что удаление было.
 */

let departmentId: string;

async function visit(tag: string) {
  if (!departmentId) {
    departmentId = crypto.randomUUID();
    await db.insert(departments).values({
      id: departmentId,
      title: { uk: "Відділення гонок", ru: "Отделение гонок" },
      timezone: "Europe/Kyiv",
    });
  }
  const specialist = await makeUser("admin", `race-s-${tag}-${crypto.randomUUID()}@test`);
  const patient = await makeUser("user", `race-p-${tag}-${crypto.randomUUID()}@test`);
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
  return { id, patient, specialist };
}

const rowOf = (appointmentId: string) =>
  db.query.visitRecordings.findFirst({ where: eq(visitRecordings.appointmentId, appointmentId) });

/**
 * Дождаться, пока чей-то UPDATE упрётся в строчный замок.
 *
 * Сигнал берётся из pg_stat_activity, а не отмеряется таймером: пауза «на
 * глаз» — это ровно тот тест, который однажды позеленеет на медленной
 * машине, ничего не проверив. Ждём именно своей базы: рядом идут прогоны
 * других баз того же сервера.
 */
async function untilBlocked(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const [row] = await client`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and state = 'active'`;
    if ((row?.n ?? 0) > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("никто не ждёт на замке: гонка не состоялась");
}

describe("удаление во время загрузки аудио", () => {
  test("залитый файл не воскрешает удалённую запись и не остаётся на диске", async () => {
    const { id, patient, specialist } = await visit("upload");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    const started = await rowOf(id);
    const onDisk = resolve(join(env.recordingsDir, `${started!.id}.enc`));

    /*
     * Гонка ставится строчным замком, а не поспешностью.
     *
     * Нужно попасть ровно между чтением строки обработчиком и его UPDATE, а
     * подгадать это временем нельзя: общий bodyLimit вычитывает тело
     * запроса ДО маршрута, поэтому «медленное тело» ничего не задерживает.
     * Вместо этого тест держит строку запертой своей транзакцией: UPDATE
     * обработчика доходит до строки и встаёт. Тогда тест удаляет запись той
     * же транзакцией (замок у неё) и коммитит. На READ COMMITTED
     * разблокированный UPDATE перечитывает строку и заново проверяет своё
     * условие — то самое поведение, ради которого условие и добавлено.
     */
    let stopping!: Promise<Response>;
    await client.begin(async (tx) => {
      await tx`select id from visit_recordings where id = ${started!.id} for update`;

      const form = new FormData();
      form.append("audio", new File([new Uint8Array(4096).fill(7)], "visit.wav", { type: "audio/wav" }));
      stopping = Promise.resolve(
        app.request(`/api/recordings/${id}/stop`, {
          method: "POST",
          headers: { Authorization: `Bearer ${specialist.token}` },
          body: form,
        }),
      );

      await untilBlocked();
      await tx`update visit_recordings
                  set status = 'discarded', audio_path = null, audio_bytes = null,
                      discarded_at = now(), discarded_by = ${patient.id}
                where id = ${started!.id}`;
      // выход из begin коммитит: с этого мгновения UPDATE обработчика оживает
    });

    const stopped = await stopping;
    // отказ, а не молчаливое «ок»: специалист должен увидеть, что записи нет
    expect(stopped.status).toBe(400);

    const row = await rowOf(id);
    expect(row!.status).toBe("discarded");
    expect(row!.audioPath).toBeNull();
    /*
     * Диск проверяется отдельно от базы. Строка могла бы остаться
     * «удалённой», а разговор — лежать файлом рядом: это ровно то, что
     * человек просил стереть.
     */
    expect(existsSync(onDisk)).toBe(false);
  });
});

describe("удаление во время расшифровки", () => {
  afterAll(() => setTranscriberForTests(null));

  test("сорвавшаяся расшифровка не поднимает удалённую запись в «не получилось»", async () => {
    const { id, patient, specialist } = await visit("transcribe");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    const path = await storeAudio(`race-${crypto.randomUUID()}`, new Uint8Array([1, 2, 3, 4]));
    await db
      .update(visitRecordings)
      .set({ status: "uploaded", audioPath: path })
      .where(eq(visitRecordings.appointmentId, id));

    /*
     * Удаление происходит внутри расшифровки — это и есть промежуток, о
     * котором речь: модель работает минутами, и всё это время человек
     * может передумать.
     */
    setTranscriberForTests({
      name: "тест",
      run: async () => {
        const res = await api(`/api/recordings/${id}/discard`, patient.token, { method: "POST" });
        expect(res.status).toBe(200);
        throw new Error("модель не загружена");
      },
    });
    expect(await transcribeNext()).toBe(true);

    const row = await rowOf(id);
    expect(row!.status).toBe("discarded");
    // и текста отказа в карте удалённой записи тоже быть не должно
    expect(row!.failure).toBeNull();

    const state = await api(`/api/recordings/${id}`, specialist.token);
    expect(state.body.status).toBe("discarded");
  });
});
