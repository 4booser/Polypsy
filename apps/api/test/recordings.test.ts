import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, app, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";
import { setTranscriberForTests, transcribeNext } from "../src/lib/recordings";

/**
 * Запись приёма голосом.
 *
 * Проверяется не «запись работает», а границы: без согласия не начинается,
 * остановить и удалить может любая сторона, стенограмма не отдаётся
 * пациенту, а удалённое стирается с диска.
 *
 * Границы здесь важнее возможности. Возможность — это кнопка; граница — это
 * то, что человек, рассказавший о себе, не окажется записанным без спроса.
 */

let departmentId: string;

async function visit(tag: string) {
  if (!departmentId) {
    departmentId = crypto.randomUUID();
    await db.insert(departments).values({
      id: departmentId,
      title: { uk: "Відділення", ru: "Отделение" },
      timezone: "Europe/Kyiv",
    });
  }
  const specialist = await makeUser("admin", `rec-s-${tag}-${crypto.randomUUID()}@test`);
  const patient = await makeUser("user", `rec-p-${tag}-${crypto.randomUUID()}@test`);
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

describe("согласие", () => {
  test("без согласия запись не начинается", async () => {
    /*
     * Кнопка на экране тоже спрятана, но полагаться на спрятанную кнопку
     * нельзя: маршрут вызывается напрямую, а цена ошибки — записанный без
     * разрешения разговор о самом личном.
     */
    const { id, specialist } = await visit("a");
    const res = await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toContain("згод");
  });

  test("согласие даёт пациент, и видно, что сам", async () => {
    const { id, patient, specialist } = await visit("b");
    const given = await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    expect(given.status).toBe(200);

    const state = await api(`/api/recordings/${id}`, specialist.token);
    expect(state.body.consentAt).not.toBeNull();
    expect(state.body.consentBySelf).toBe(true);
  });

  test("согласие с его слов отличается от согласия самого", async () => {
    /*
     * «Согласился сам» и «записано с его слов» — разные основания, и при
     * разборе разница существенна.
     */
    const { id, specialist } = await visit("c");
    await api(`/api/recordings/${id}/consent`, specialist.token, { method: "POST" });
    const state = await api(`/api/recordings/${id}`, specialist.token);
    expect(state.body.consentAt).not.toBeNull();
    expect(state.body.consentBySelf).toBe(false);
  });

  test("согласие отзывается до начала записи", async () => {
    // право передумать до того, как что-то сказано, не требует объяснений
    const { id, patient, specialist } = await visit("d");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    const revoked = await api(`/api/recordings/${id}/consent/revoke`, patient.token, {
      method: "POST",
    });
    expect(revoked.status).toBe(200);

    const res = await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("посторонний о записи не узнаёт", async () => {
    const { id } = await visit("e");
    const stranger = await makeUser("admin", `rec-x-${crypto.randomUUID()}@test`);
    const res = await api(`/api/recordings/${id}`, stranger.token);
    // «не найдено», а не «нельзя»: по коду отказа нельзя узнать, что приём есть
    expect(res.status).toBe(404);
  });
});

describe("ход записи", () => {
  test("останавливает и пациент", async () => {
    /*
     * Это разговор двоих, и право прекратить его запись есть у обоих; у
     * пациента — в первую очередь.
     */
    const { id, patient, specialist } = await visit("f");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });

    const stopped = await api(`/api/recordings/${id}/stop`, patient.token, { method: "POST" });
    expect(stopped.status).toBe(200);

    const state = await api(`/api/recordings/${id}`, specialist.token);
    expect(state.body.status).not.toBe("recording");
  });

  test("повторный старт во время записи отклоняется", async () => {
    const { id, patient, specialist } = await visit("g");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    const again = await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });
    expect(again.status).toBe(400);
  });
});

describe("расшифровка", () => {
  afterAll(() => setTranscriberForTests(null));

  test("стенограмма не отдаётся пациенту", async () => {
    /*
     * Это не его запись о себе, а рабочий материал приёма. Читать её без
     * объяснений — то же, что читать черновик заключения.
     */
    const { id, patient, specialist } = await visit("h");
    const [rec] = await db
      .select()
      .from(visitRecordings)
      .where(eq(visitRecordings.appointmentId, id));
    // строки может ещё не быть — создаётся при первом обращении
    await api(`/api/recordings/${id}`, specialist.token);
    const { encryptField } = await import("../src/lib/crypto");
    await db
      .update(visitRecordings)
      .set({ status: "done", transcriptEnc: encryptField("Пациент сообщил о бессоннице") })
      .where(eq(visitRecordings.appointmentId, id));

    const forStaff = await api(`/api/recordings/${id}`, specialist.token);
    expect(forStaff.body.transcript).toContain("бессоннице");

    const forPatient = await api(`/api/recordings/${id}`, patient.token);
    expect(forPatient.body.transcript).toBeNull();
  });

  test("отказ расшифровки виден словами, а не молчанием", async () => {
    /*
     * Молчаливый провал означал бы запись, которая «обрабатывается» третью
     * неделю, и человека, который ждёт стенограммы, не подозревая, что её не
     * будет.
     *
     * Аудио записывается настоящее: первая редакция подставляла
     * несуществующий путь, и до расшифровщика дело не доходило — падало
     * чтение файла. Проверка проходила, но проверяла не то.
     */
    const { id, patient, specialist } = await visit("i");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });

    const { storeAudio } = await import("../src/lib/recordings");
    const path = await storeAudio(`test-${crypto.randomUUID()}`, new Uint8Array([1, 2, 3, 4]));
    await db
      .update(visitRecordings)
      .set({ status: "uploaded", audioPath: path })
      .where(eq(visitRecordings.appointmentId, id));

    let reached = false;
    setTranscriberForTests({
      name: "тест",
      run: async () => {
        reached = true;
        throw new Error("модель не загружена");
      },
    });
    await transcribeNext();
    expect(reached).toBe(true);

    const state = await api(`/api/recordings/${id}`, specialist.token);
    expect(state.body.status).toBe("failed");
    expect(String(state.body.failure)).toContain("модель не загружена");
  });

  test("успешная расшифровка кладёт текст и называет движок", async () => {
    /*
     * Чем расшифровано, хранится рядом со стенограммой: без этого через год
     * не понять, почему одна стенограмма лучше другой.
     */
    const { id, patient, specialist } = await visit("i2");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });

    const { storeAudio } = await import("../src/lib/recordings");
    const path = await storeAudio(`test-${crypto.randomUUID()}`, new Uint8Array([5, 6, 7, 8]));
    await db
      .update(visitRecordings)
      .set({ status: "uploaded", audioPath: path })
      .where(eq(visitRecordings.appointmentId, id));

    setTranscriberForTests({
      name: "whisper.cpp тестовый",
      run: async () => "Пациент говорит о тревоге перед выездом.",
    });
    await transcribeNext();

    const state = await api(`/api/recordings/${id}`, specialist.token);
    expect(state.body.status).toBe("done");
    expect(state.body.transcript).toContain("тревоге");
    expect(state.body.transcriptEngine).toBe("whisper.cpp тестовый");
  });

  test("когда расшифровывать нечем, об этом сказано", async () => {
    setTranscriberForTests(null);
    const { id, specialist } = await visit("j");
    const state = await api(`/api/recordings/${id}`, specialist.token);
    // в тестовой среде whisper не настроен — и экран обязан это показать
    expect(state.body.transcriptionAvailable).toBe(false);
  });
});

describe("удаление", () => {
  test("удаляет любая сторона, след остаётся", async () => {
    /*
     * Сказанное сгоряча человек вправе забрать назад, пока оно не стало
     * текстом в карте. Строка остаётся: исчезновение записи не должно быть
     * неотличимо от того, что её не делали.
     */
    const { id, patient, specialist } = await visit("k");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });

    const discarded = await api(`/api/recordings/${id}/discard`, patient.token, { method: "POST" });
    expect(discarded.status).toBe(200);

    const [row] = await db
      .select()
      .from(visitRecordings)
      .where(eq(visitRecordings.appointmentId, id));
    expect(row!.status).toBe("discarded");
    expect(row!.discardedBy).toBe(patient.id);
    expect(row!.audioPath).toBeNull();
  });

  test("расшифрованное удалять поздно", async () => {
    // текст уже в карте, и стирать аудио задним числом — делать вид
    const { id, specialist } = await visit("l");
    await api(`/api/recordings/${id}`, specialist.token);
    await db
      .update(visitRecordings)
      .set({ status: "done" })
      .where(eq(visitRecordings.appointmentId, id));

    const res = await api(`/api/recordings/${id}/discard`, specialist.token, { method: "POST" });
    expect(res.status).toBe(400);
  });
});

describe("запись ведёт специалист, а не пациент", () => {
  test("пациент не может начать запись", async () => {
    /*
     * Доступ к маршрутам записи даёт общая проверка «сторона приёма», и она
     * пускает обоих — это правильно для согласия и остановки. Но начинать
     * запись вправе только тот, кто ведёт приём.
     */
    const { id, patient } = await visit("startby");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });

    const res = await api(`/api/recordings/${id}/start`, patient.token, { method: "POST" });
    expect(res.status).toBe(403);
  });

  test("пациент не может подложить своё аудио", async () => {
    /*
     * Главное здесь. Без проверки пациент начинал запись, затем отправлял
     * «остановку» со своим файлом — и подготовленная им запись шифровалась,
     * расшифровывалась и показывалась специалисту как стенограмма ЭТОГО
     * приёма. Подделка клинической записи о разговоре, которого не было.
     *
     * Остановку без файла пациенту оставляем: прекратить запись разговора о
     * себе он вправе в любой момент.
     */
    const { id, patient, specialist } = await visit("uploadby");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });

    const form = new FormData();
    form.append("audio", new File([new Uint8Array(64)], "fake.wav", { type: "audio/wav" }));
    const res = await app.request(`/api/recordings/${id}/stop`, {
      method: "POST",
      headers: { Authorization: `Bearer ${patient.token}` },
      body: form,
    });
    expect(res.status, "пациент передал аудио как стенограмму приёма").toBe(403);

    // а остановить без файла — по-прежнему может
    const stopped = await api(`/api/recordings/${id}/stop`, patient.token, { method: "POST" });
    expect(stopped.status).toBe(200);
  });

  test("удаление записи уносит и стенограмму", async () => {
    /*
     * Раньше обнулялся только файл. Расшифровка идёт минутами, и текст мог
     * лечь в базу уже после просьбы удалить — оставаясь там навсегда при
     * надписи «удалена». Стенограмма — тот же разговор, только буквами.
     */
    const { id, patient, specialist } = await visit("discard");
    await api(`/api/recordings/${id}/consent`, patient.token, { method: "POST" });
    await api(`/api/recordings/${id}/start`, specialist.token, { method: "POST" });

    const { visitRecordings } = await import("../src/db/schema");
    await db
      .update(visitRecordings)
      .set({ transcriptEnc: "нечто", status: "uploaded" })
      .where(eq(visitRecordings.appointmentId, id));

    const res = await api(`/api/recordings/${id}/discard`, patient.token, { method: "POST" });
    expect(res.status).toBe(200);

    const row = await db.query.visitRecordings.findFirst({
      where: eq(visitRecordings.appointmentId, id),
    });
    expect(row?.transcriptEnc, "стенограмма пережила удаление записи").toBeNull();
  });
});
