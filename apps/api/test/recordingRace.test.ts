import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { api, app, client, db, makeUser } from "./fixtures";
import { appointments, departments, slots, specialistProfiles, visitRecordings } from "../src/db/schema";
import {
  eraseAudio,
  setTranscribeTimingForTests,
  setTranscriberForTests,
  storeAudio,
  transcribeNext,
} from "../src/lib/recordings";
import { baseDb } from "../src/db";
import { systemContext } from "../src/db/context";
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
    /*
     * Своя запись — самой старой в очереди: transcribeNext берёт старейшую
     * «uploaded» во всей таблице, а другие файлы (bodyLimit, recordings)
     * оставляют там свои. Без этого очередь подхватывала чужую, run() всё
     * равно удалял нашу — и гонка не проверялась вовсе (волна 12, integrity).
     */
    await db
      .update(visitRecordings)
      .set({ status: "uploaded", audioPath: path, createdAt: "1990-01-01T00:00:00.000Z" })
      .where(eq(visitRecordings.appointmentId, id));

    /*
     * Удаление происходит внутри расшифровки — это и есть промежуток, о
     * котором речь: модель работает минутами, и всё это время человек
     * может передумать.
     */
    setTranscriberForTests({
      name: "тест",
      run: async (audio) => {
        // расшифровывается именно наша запись, а не чужая из общей очереди
        expect([...audio]).toEqual([1, 2, 3, 4]);
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

/* ═══════════ расшифровка так, как её ведёт воркер ═══════════ */

/**
 * Обещание — или «не дождались» за отведённый срок.
 *
 * Срок здесь потолок, а не пауза: исправный путь отвечает за миллисекунды,
 * и тест ждёт ровно столько. Потолок нужен неисправному: удаление, стоящее
 * на замке воркера, ждало бы конца расшифровки, а расшифровка — конца
 * удаления, и тест висел бы до общего таймаута, ничего не сказав.
 */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Записи, поставленные в очередь этим блоком: закрываются в afterAll */
const queuedHere: { recordingId: string; path: string }[] = [];

/**
 * Запись приёма с настоящим файлом по настоящему пути — первой в очереди.
 *
 * Путь тот же, что даёт остановка (`<id записи>.enc`): от этого зависит,
 * какой файл и когда стирать, и подставной путь проверял бы не то. Дата
 * заведения — в прошлом веке: очередь общая на все файлы сюиты, и чужая
 * строка в «uploaded» (соседи её оставляют) иначе ушла бы первой.
 */
async function queued(tag: string) {
  const v = await visit(tag);
  await api(`/api/recordings/${v.id}/consent`, v.patient.token, { method: "POST" });
  const rec = await rowOf(v.id);
  const path = await storeAudio(rec!.id, new Uint8Array([3, 1, 4, 1, 5]));
  await db
    .update(visitRecordings)
    .set({ status: "uploaded", audioPath: path, audioBytes: 5, createdAt: "1999-01-01T00:00:00.000Z" })
    .where(eq(visitRecordings.id, rec!.id));
  queuedHere.push({ recordingId: rec!.id, path });
  return { ...v, recordingId: rec!.id, path };
}

/**
 * Снять свою запись с очереди сразу, а не в afterAll.
 *
 * Следующий тест ставит свою запись тем же прошлым веком, и оставленная
 * живой соседка ушла бы в работу вместо неё — тест проверял бы чужую строку.
 */
async function closeQueued(q: { recordingId: string; path: string }) {
  await db
    .update(visitRecordings)
    .set({ status: "discarded", audioPath: null, audioBytes: null })
    .where(eq(visitRecordings.id, q.recordingId));
  await eraseAudio(q.path);
}

/**
 * Два способа позвать расшифровку.
 *
 * Первый — как воркер зовёт её теперь. Второй — как звал до правки: весь
 * проход внутри systemContext, то есть внутри одной транзакции. Прежний тест
 * звал функцию голой, без транзакции вокруг, — и потому не видел главного:
 * в воркере захват строки держался до конца работы модели, удаление и отзыв
 * согласия ждали на её замке минутами, а статус «розшифровується» не был
 * виден никому, пока всё не закончится. Второй способ оставлен нарочно:
 * расшифровка обязана вести себя одинаково, в какой бы транзакции её ни
 * позвали.
 */
const shapes: [string, () => Promise<boolean>][] = [
  ["как зовёт воркер", () => transcribeNext()],
  ["внутри внешней транзакции", () => systemContext(baseDb, () => transcribeNext())],
];

describe("расшифровка вне транзакции", () => {
  afterAll(async () => {
    setTranscriberForTests(null);
    setTranscribeTimingForTests(null);
    // ничего живого в общей очереди: соседние файлы берут из неё САМУЮ старую
    const ids = queuedHere.map((q) => q.recordingId);
    if (ids.length) {
      await db
        .update(visitRecordings)
        .set({ status: "discarded", audioPath: null, audioBytes: null })
        .where(and(inArray(visitRecordings.id, ids), inArray(visitRecordings.status, ["uploaded", "transcribing"])));
    }
    for (const q of queuedHere) await eraseAudio(q.path);
  });

  const actions = [
    { name: "удаление", path: "discard", status: "discarded" },
    { name: "отзыв согласия", path: "consent/revoke", status: "consent_pending" },
  ] as const;

  for (const [shape, runWorker] of shapes) {
    for (const action of actions) {
      test(`${action.name} во время работы модели не ждёт её, и её итог не ложится в карту — ${shape}`, async () => {
        const q = await queued(`${action.path}-${shape}`);

        let during: { seen: string | null; answer: number | "timeout" } | null = null;
        setTranscriberForTests({
          name: "тест",
          run: async () => {
            /*
             * Смотрим ЧУЖИМ соединением, вне транзакции воркера: так видит
             * запись экран приёма. «Розшифровується» должно быть видно
             * сразу, а не после того, как всё кончится.
             */
            const [row] = await client`select status from visit_recordings where id = ${q.recordingId}`;
            const res = await within(
              api(`/api/recordings/${q.id}/${action.path}`, q.patient.token, { method: "POST" }),
              3000,
            );
            during = { seen: row?.status ?? null, answer: res === "timeout" ? "timeout" : res.status };
            return "Пацієнт сказав зайве і попросив це прибрати.";
          },
        });

        expect(await runWorker()).toBe(true);
        expect(during!, "удаление/отзыв ждали конца расшифровки на замке воркера").toEqual({
          seen: "transcribing",
          answer: 200,
        });

        const row = await rowOf(q.id);
        expect(row!.status).toBe(action.status);
        expect(row!.transcriptEnc, "стенограмма разговора, который просили убрать").toBeNull();
        expect(row!.audioPath).toBeNull();
        expect(existsSync(q.path), "файл разговора остался на диске").toBe(false);
      });
    }
  }

  test("отзыв, заставший «розшифровується», уносит и стенограмму, дописанную за это время", async () => {
    /*
     * Обратный порядок той же гонки. Отзыв прочитал строку, когда модель
     * ещё работала, а записать своё успел уже ПОСЛЕ того, как воркер
     * положил стенограмму. Отзыв обнулял аудио и согласие, но не текст — и
     * разговор, на хранение которого согласия больше нет, оставался в базе
     * буквами (на экране его не видно только потому, что статус уже не
     * «готово»).
     *
     * Промежуток ставится строчным замком, как в тесте загрузки выше:
     * UPDATE отзыва доходит до строки и встаёт, тест той же транзакцией
     * пишет итог «воркера» и коммитит.
     */
    const q = await queued("revoke-late");
    await db.update(visitRecordings).set({ status: "transcribing" }).where(eq(visitRecordings.id, q.recordingId));
    const { encryptField } = await import("../src/lib/crypto");

    let revoking!: Promise<{ status: number }>;
    await client.begin(async (tx) => {
      await tx`select id from visit_recordings where id = ${q.recordingId} for update`;
      revoking = api(`/api/recordings/${q.id}/consent/revoke`, q.patient.token, { method: "POST" });
      await untilBlocked();
      await tx`update visit_recordings
                  set status = 'done', transcript_enc = ${encryptField("Пацієнт розповів про безсоння.")},
                      transcript_engine = 'тест', transcript_at = now()
                where id = ${q.recordingId}`;
    });

    expect((await revoking).status).toBe(200);
    const row = await rowOf(q.id);
    expect(row!.status).toBe("consent_pending");
    expect(row!.transcriptEnc).toBeNull();
    expect(row!.transcriptEngine).toBeNull();
  });

  test("брошенный упавшим воркером захват подбирается, когда истекла аренда", async () => {
    /*
     * Обратная сторона короткого захвата: коммит уже был, и упавший посреди
     * работы воркер строку откатом не отпускает. Без аренды запись осталась
     * бы в «розшифровується» навсегда — ровно то, от чего предостерегают
     * комментарии про «обрабатывается третью неделю».
     */
    const q = await queued("orphan");
    await db
      .update(visitRecordings)
      .set({
        status: "transcribing",
        transcribeClaim: "упавший-воркер",
        transcribeLeaseUntil: new Date(Date.now() - 60_000).toISOString(),
      })
      .where(eq(visitRecordings.id, q.recordingId));

    setTranscriberForTests({ name: "тест", run: async () => "Пацієнт говорить про сон." });
    expect(await transcribeNext()).toBe(true);

    const row = await rowOf(q.id);
    expect(row!.status).toBe("done");
    expect(row!.transcribeClaim).toBeNull();
    expect(row!.transcribeLeaseUntil).toBeNull();
  });

  test("опоздавший воркер не пишет поверх чужого захвата", async () => {
    /*
     * Воркер завис дольше аренды (или моргнула база, и продления не
     * дошли), строку взял другой — у неё теперь другая метка захвата. Итог
     * опоздавшего отбрасывается: иначе две расшифровки одной записи писали
     * бы по очереди, и в карте осталась бы та, что закончилась позже, — а не
     * та, что расшифровывает запись сейчас.
     */
    const q = await queued("taken");
    setTranscriberForTests({
      name: "тест",
      run: async () => {
        await client`update visit_recordings set transcribe_claim = 'другой-воркер' where id = ${q.recordingId}`;
        return "Старий підсумок, який уже нікому не належить.";
      },
    });
    expect(await transcribeNext()).toBe(true);

    const row = await rowOf(q.id);
    expect(row!.status, "итог опоздавшего воркера лёг поверх чужого захвата").toBe("transcribing");
    expect(row!.transcriptEnc).toBeNull();
    expect(row!.transcribeClaim).toBe("другой-воркер");
    // файл на месте: его расшифровывает тот, другой
    expect(existsSync(q.path)).toBe(true);
    await closeQueued(q);
  });

  test("удалили и записали заново, пока работала модель: старый итог не ложится, новый файл цел", async () => {
    /*
     * После удаления согласие остаётся, и специалист вправе начать запись
     * снова. Путь у файла тот же (`<id записи>.enc`). Отбрасывая итог,
     * расшифровка стирает файл удалённой записи — и если бы она не
     * смотрела, что строка уже снова ссылается на файл, она стёрла бы
     * НОВЫЙ разговор.
     */
    const q = await queued("again");
    setTranscriberForTests({
      name: "тест",
      run: async () => {
        expect((await api(`/api/recordings/${q.id}/discard`, q.patient.token, { method: "POST" })).status).toBe(200);
        expect((await api(`/api/recordings/${q.id}/start`, q.specialist.token, { method: "POST" })).status).toBe(200);
        const form = new FormData();
        form.append("audio", new File([new Uint8Array(64).fill(2)], "visit.wav", { type: "audio/wav" }));
        const stopped = await app.request(`/api/recordings/${q.id}/stop`, {
          method: "POST",
          headers: { Authorization: `Bearer ${q.specialist.token}` },
          body: form,
        });
        expect(stopped.status).toBe(200);
        return "Підсумок видаленої розмови.";
      },
    });
    expect(await transcribeNext()).toBe(true);

    const row = await rowOf(q.id);
    expect(row!.status).toBe("uploaded");
    expect(row!.transcriptEnc).toBeNull();
    expect(row!.audioPath).toBe(q.path);
    expect(existsSync(q.path), "стёрт файл новой записи").toBe(true);
    await closeQueued(q);
  });

  test("пока модель работает, аренда продлевается; удалили — модель просят остановиться", async () => {
    setTranscribeTimingForTests({ leaseMs: 60_000, heartbeatMs: 20 });
    try {
      const q = await queued("beat");
      let extended = false;
      let stopped: boolean | "timeout" = false;
      setTranscriberForTests({
        name: "тест",
        run: async (_audio, _lang, signal) => {
          const lease = async () =>
            String((await client`select transcribe_lease_until::text as l from visit_recordings where id = ${q.recordingId}`)[0]?.l);
          const first = await lease();
          for (let i = 0; i < 100 && !extended; i++) {
            await new Promise((r) => setTimeout(r, 20));
            extended = (await lease()) > first;
          }
          await api(`/api/recordings/${q.id}/discard`, q.patient.token, { method: "POST" });
          stopped = await within(
            new Promise<boolean>((r) => {
              if (signal?.aborted) r(true);
              signal?.addEventListener("abort", () => r(true), { once: true });
            }),
            3000,
          );
          return "Не мало б записатися.";
        },
      });
      expect(await transcribeNext()).toBe(true);
      expect(extended, "аренда не продлевалась — её перехватили бы у живого воркера").toBe(true);
      expect(stopped, "удаление не остановило модель").toBe(true);
      expect((await rowOf(q.id))!.status).toBe("discarded");
    } finally {
      setTranscribeTimingForTests(null);
    }
  });
});
