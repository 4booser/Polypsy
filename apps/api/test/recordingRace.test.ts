import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { api, app, client, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";
import { eraseAudio, readAudio, setTranscriberForTests, storeAudio, transcribeNext } from "../src/lib/recordings";
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
  mine.push(id);
  return { id, patient, specialist };
}

/** Приёмы этого файла: в конце их записи уводятся из общей очереди */
const mine: string[] = [];
afterAll(async () => {
  if (!mine.length) return;
  const rows = await db.select().from(visitRecordings).where(inArray(visitRecordings.appointmentId, mine));
  for (const row of rows) await eraseAudio(row.audioPath);
  await db
    .update(visitRecordings)
    .set({ status: "discarded", audioPath: null, audioBytes: null })
    .where(inArray(visitRecordings.appointmentId, mine));
});

/** Запись браузера: сигнатура WebM и заполнитель — приём файла смотрит в байты */
const EBML = [0x1a, 0x45, 0xdf, 0xa3];
function webm(size: number, fill: number): Uint8Array {
  const b = new Uint8Array(size).fill(fill);
  b.set(EBML, 0);
  return b;
}

function stopWith(id: string, token: string, bytes: Uint8Array | null, uploadId?: string): Promise<Response> {
  const form = new FormData();
  if (bytes) form.append("audio", new File([bytes], "visit.webm", { type: "audio/webm" }));
  if (uploadId) form.append("uploadId", uploadId);
  return Promise.resolve(
    app.request(`/api/recordings/${id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }),
  );
}

/** Файлы этой записи в хранилище: имя начинается с id строки записи */
async function filesOf(recId: string): Promise<string[]> {
  const names = await readdir(resolve(env.recordingsDir)).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith(recId)).sort();
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
async function untilBlocked(waiting = 1): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await client`
      select count(*)::int as n
        from pg_stat_activity
       where datname = current_database()
         and wait_event_type = 'Lock'
         and state = 'active'`;
    if ((row?.n ?? 0) >= waiting) return;
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

      stopping = stopWith(id, specialist.token, webm(4096, 7));

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
    expect(await filesOf(started!.id), "от удалённой записи на диске остался файл").toEqual([]);
  });
});

describe("отзыв согласия", () => {
  test("отозванное согласие уносит записанное аудио с диска", async () => {
    /*
     * Отзыв менял только отметку согласия. При состояниях uploaded и
     * transcribing файл оставался лежать: согласия нет, а разговор хранится
     * и вот-вот станет стенограммой. Основание хранить запись — согласие.
     */
    const { id, patient, specialist } = await visit("revoke");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    const rec = await rowOf(id);
    const path = await storeAudio(rec!.id, new Uint8Array([9, 9, 9, 9]));
    await db
      .update(visitRecordings)
      .set({ status: "uploaded", audioPath: path, audioBytes: 4 })
      .where(eq(visitRecordings.id, rec!.id));
    expect(existsSync(path)).toBe(true);

    const res = await api(`/api/recordings/${id}/consent/revoke`, patient.token, { method: "POST" });
    expect(res.status).toBe(200);

    expect(existsSync(path), "разговор остался на диске без согласия").toBe(false);
    const after = await rowOf(id);
    expect(after!.audioPath).toBeNull();
    expect(after!.audioBytes).toBeNull();
    expect(after!.status).toBe("consent_pending");

    // и расшифровке взять уже нечего: очередь её не подхватит
    const state = await api(`/api/recordings/${id}`, specialist.token);
    expect(state.body.status).toBe("consent_pending");
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

describe("две остановки одновременно", () => {
  test("проигравшая остановка не уносит файл победившей", async () => {
    /*
     * Обе остановки писали файл по одному пути (`<id записи>.enc`). Та, что
     * проигрывала условное обновление, стирала «свой» файл — а он был общим:
     * в базе «загружено», на диске пусто. Разговор потерян при том, что
     * специалист увидел «ок».
     *
     * Гонка ставится тем же замком, что и выше: обе остановки успевают
     * записать файл и встают на UPDATE, затем замок отпускается.
     */
    const { id, patient, specialist } = await visit("double-stop");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    const started = await rowOf(id);

    const a = webm(4096, 1);
    const b = webm(6144, 2);
    let first!: Promise<Response>;
    let second!: Promise<Response>;
    await client.begin(async (tx) => {
      await tx`select id from visit_recordings where id = ${started!.id} for update`;
      first = stopWith(id, specialist.token, a);
      second = stopWith(id, specialist.token, b);
      await untilBlocked(2);
    });

    const codes = [(await first).status, (await second).status].sort();
    expect(codes).toEqual([200, 400]);

    const row = await rowOf(id);
    expect(row!.status).toBe("uploaded");
    expect(existsSync(row!.audioPath!), "у победившей загрузки на диске нет файла").toBe(true);
    const plain = await readAudio(row!.audioPath!);
    // в файле — ровно то, о чём говорит строка, а не половина чужой записи
    expect(plain.byteLength).toBe(row!.audioBytes!);
    expect([a.byteLength, b.byteLength]).toContain(plain.byteLength);
    // и проигравший не оставил после себя своего файла
    expect(await filesOf(started!.id)).toEqual([basename(row!.audioPath!)]);
  });

  test("та же отправка дважды (двойное нажатие, повтор при обрыве) — обе «принято», файл один", async () => {
    const { id, patient, specialist } = await visit("same-key");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    const started = await rowOf(id);
    const bytes = webm(4096, 11);
    const uploadId = crypto.randomUUID();

    let first!: Promise<Response>;
    let second!: Promise<Response>;
    await client.begin(async (tx) => {
      await tx`select id from visit_recordings where id = ${started!.id} for update`;
      first = stopWith(id, specialist.token, bytes, uploadId);
      second = stopWith(id, specialist.token, bytes, uploadId);
      await untilBlocked(2);
    });

    expect([(await first).status, (await second).status]).toEqual([200, 200]);
    const row = await rowOf(id);
    expect(row!.status).toBe("uploaded");
    expect(row!.uploadId).toBe(uploadId);
    expect((await readAudio(row!.audioPath!)).byteLength).toBe(bytes.byteLength);
    expect(await filesOf(started!.id)).toEqual([basename(row!.audioPath!)]);
  });
});

describe("начало записи и отзыв согласия одновременно", () => {
  test("запись не начинается, если согласие отозвали, пока шла проверка", async () => {
    /*
     * Проверка согласия и перевод в «идёт запись» были двумя шагами:
     * обработчик читал строку, видел согласие и безусловно ставил
     * «recording». Отзыв, пришедший между ними, отрабатывал полностью — а
     * запись всё равно начиналась: 200, status=recording, consent_at=null.
     */
    const { id, patient, specialist } = await visit("start-revoke");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    const rec = await rowOf(id);

    let starting!: Promise<Response>;
    await client.begin(async (tx) => {
      await tx`select id from visit_recordings where id = ${rec!.id} for update`;
      starting = Promise.resolve(
        app.request(`/api/recordings/${id}/start`, {
          method: "POST",
          headers: { Authorization: `Bearer ${specialist.token}` },
        }),
      );
      await untilBlocked();
      // отзыв — тем же изменением, что делает маршрут отзыва
      await tx`update visit_recordings
                  set consent_at = null, consent_by = null, status = 'consent_pending'
                where id = ${rec!.id}`;
    });

    const res = await starting;
    expect(res.status, "запись началась без согласия").toBe(403);
    const row = await rowOf(id);
    expect(row!.status).toBe("consent_pending");
    expect(row!.consentAt).toBeNull();
    expect(row!.startedAt).toBeNull();
  });
});

describe("удаление сразу после загрузки", () => {
  test("файл, залитый за миг до удаления, стирается вместе с записью", async () => {
    /*
     * Удаление стирало путь, прочитанный в начале обработчика. Если
     * загрузка успевала закоммититься между чтением и обновлением, путь был
     * ещё пуст: строка становилась «удалена», а залитый файл оставался на
     * диске без ссылки на него — ровно то, что человек просил стереть.
     */
    const { id, patient, specialist } = await visit("discard-upload");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    const rec = await rowOf(id);
    const uploaded = await storeAudio(rec!.id, webm(2048, 5));

    let discarding!: Promise<Response>;
    await client.begin(async (tx) => {
      await tx`select id from visit_recordings where id = ${rec!.id} for update`;
      discarding = Promise.resolve(
        app.request(`/api/recordings/${id}/discard`, {
          method: "POST",
          headers: { Authorization: `Bearer ${patient.token}` },
        }),
      );
      await untilBlocked();
      // остановка специалиста успела первой: файл на диске, строка — «загружено»
      await tx`update visit_recordings
                  set status = 'uploaded', audio_path = ${uploaded}, audio_bytes = 2048
                where id = ${rec!.id}`;
    });

    expect((await discarding).status).toBe(200);
    const row = await rowOf(id);
    expect(row!.status).toBe("discarded");
    expect(row!.audioPath).toBeNull();
    expect(existsSync(uploaded), "удалённая запись осталась на диске").toBe(false);
  });
});

describe("повторная отправка аудио", () => {
  test("повтор после потерянного ответа подтверждается, а не отклоняется", async () => {
    /*
     * Сеть рвётся и после того, как сервер всё сохранил: ответ до браузера
     * не дошёл. Клиент держит запись и шлёт её снова — и прежде получал 400
     * «запись не идёт». Специалист видел отказ при сохранённой записи и не
     * мог понять, дошла ли она.
     *
     * Ключ отправки придумывает клиент один раз на запись; по нему сервер
     * узнаёт повтор и отвечает «принято», ничего не записывая второй раз.
     */
    const { id, patient, specialist } = await visit("retry");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    const uploadId = crypto.randomUUID();
    const bytes = webm(4096, 3);

    expect((await stopWith(id, specialist.token, bytes, uploadId)).status).toBe(200);
    const once = await rowOf(id);

    const again = await stopWith(id, specialist.token, bytes, uploadId);
    expect(again.status, "повтор той же отправки отклонён").toBe(200);
    const twice = await rowOf(id);
    expect(twice!.audioPath).toBe(once!.audioPath);
    expect(twice!.endedAt).toBe(once!.endedAt);
    expect(await filesOf(once!.id)).toEqual([basename(once!.audioPath!)]);

    // другая отправка (другой ключ) по-прежнему не принимается и не оставляет файла
    const other = await stopWith(id, specialist.token, webm(4096, 4), crypto.randomUUID());
    expect(other.status).toBe(400);
    expect(await filesOf(once!.id)).toEqual([basename(once!.audioPath!)]);
  });

  test("аудио доходит, если запись остановил пациент", async () => {
    /*
     * Пациент вправе остановить запись со своего телефона, и сервер
     * переводил её в «готово» без аудио — «у того, кто писал, файл ещё на
     * устройстве, и он его дошлёт». Дослать было некуда: остановка с файлом
     * требовала «идёт запись» и отвечала 400. Разговор, записанный с
     * согласия до самой остановки, пропадал.
     */
    const { id, patient, specialist } = await visit("patient-stop");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    expect((await api(`/api/recordings/${id}/stop`, patient.token, { method: "POST" })).status).toBe(200);
    const stopped = await rowOf(id);
    expect(stopped!.status).toBe("ready");

    const res = await stopWith(id, specialist.token, webm(4096, 6), crypto.randomUUID());
    expect(res.status, "записанное до остановки пациентом аудио не принято").toBe(200);
    const row = await rowOf(id);
    expect(row!.status).toBe("uploaded");
    // конец записи — момент, когда её остановил пациент, а не когда дошёл файл
    expect(row!.endedAt).toBe(stopped!.endedAt);
    expect(row!.durationMs).toBe(
      new Date(stopped!.endedAt!).getTime() - new Date(stopped!.startedAt!).getTime(),
    );
  });

  test("после отзыва и нового согласия прежнее аудио не принимается", async () => {
    // согласие отозвано — основания хранить ту запись нет, и новое согласие его не возвращает
    const { id, patient, specialist } = await visit("revoked-late");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    await api(`/api/recordings/${id}/stop`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/consent/revoke`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });

    const res = await stopWith(id, specialist.token, webm(4096, 8), crypto.randomUUID());
    expect(res.status).toBe(400);
    const row = await rowOf(id);
    expect(row!.status).toBe("ready");
    expect(row!.audioPath).toBeNull();
    expect(await filesOf(row!.id)).toEqual([]);
  });
});

describe("одна запись на приём", () => {
  test("новая запись не начинается поверх сохранённого аудио", async () => {
    /*
     * Упавшая расшифровка хранит файл: её повторяют из техпанели. Новый
     * старт поверх неё прежде проходил, и следующая загрузка молча
     * подменяла прежний разговор другим — или оставляла старый файл без
     * ссылки. Сначала удалить, потом записывать заново.
     */
    const { id, patient, specialist } = await visit("over-failed");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    const rec = await rowOf(id);
    const path = await storeAudio(rec!.id, webm(1024, 9));
    await db
      .update(visitRecordings)
      .set({ status: "failed", audioPath: path, audioBytes: 1024, failure: "тест" })
      .where(eq(visitRecordings.id, rec!.id));

    const res = await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    expect(res.status).toBe(400);
    const row = await rowOf(id);
    expect(row!.status).toBe("failed");
    expect(existsSync(path)).toBe(true);
  });
});
