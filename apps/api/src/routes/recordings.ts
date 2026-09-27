import { Hono, type Context } from "hono";
import { and, eq, gte, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "../db";
import { requestIsReadOnly } from "../db/context";
import { appointments, visitRecordings } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { badRequest, forbidden, notFound, } from "../lib/http";
import {
  eraseAudio,
  pendingTranscriptions,
  sniffAudio,
  storeAudio,
  transcriptionAvailable,
} from "../lib/recordings";
import { isStaff } from "../lib/scope";
import { requireAuth, type AppEnv } from "../middleware/auth";

/**
 * Запись приёма голосом.
 *
 * Самые чувствительные данные в системе: не результат методики, а разговор
 * человека о себе целиком. Поэтому здесь три вещи, которых нет у остальных
 * маршрутов.
 *
 * Первое: согласие на запись ИМЕННО ЭТОГО приёма, проверяемое сервером.
 * Галочка в общем согласии, подписанном год назад, здесь не годится — человек
 * соглашался на обследование, а не на то, что сегодняшний разговор запишут.
 *
 * Второе: остановить может любая сторона. Это разговор двоих, и право
 * прекратить его запись есть у обоих; у пациента — в первую очередь.
 *
 * Третье: удалить до расшифровки может тоже любая сторона. Сказанное сгоряча
 * человек вправе забрать назад, пока оно не стало текстом в карте.
 */
export const recordingRoutes = new Hono<AppEnv>();

recordingRoutes.use("*", requireAuth);

/** Приём, к которому у спрашивающего есть отношение; иначе «не найдено» */
async function visitOf(c: Context<AppEnv>, id: string) {
  const row = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  if (!row) notFound("err.appointmentNotFound");
  const me = c.get("user");
  if (row.patientId !== me.id && row.specialistId !== me.id) {
    notFound("err.appointmentNotFound");
  }
  return row;
}

/** Строка записи для приёма; создаётся при первом обращении */
async function recordingFor(appointmentId: string, patientId: string, specialistId: string) {
  const [existing] = await db
    .select()
    .from(visitRecordings)
    .where(eq(visitRecordings.appointmentId, appointmentId));
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db
    .insert(visitRecordings)
    .values({ id, appointmentId, patientId, specialistId })
    .onConflictDoNothing();
  const [created] = await db
    .select()
    .from(visitRecordings)
    .where(eq(visitRecordings.appointmentId, appointmentId));
  return created!;
}

/** Начальное состояние записи, которой ещё нет в базе (см. GET ниже) */
function unsavedRecording(patientId: string) {
  return {
    id: null,
    status: "consent_pending" as const,
    consentAt: null,
    consentBy: null,
    patientId,
    startedAt: null,
    durationMs: null,
    transcriptEnc: null,
    transcriptEngine: null,
    failure: null,
  };
}

type RecordingRow = typeof visitRecordings.$inferSelect;

/**
 * Строка записи под замком до конца запроса.
 *
 * Запрос идёт одной транзакцией (requireAuth → withDbContext), и замок
 * держится до её конца. Нужен тем, кто стирает файл: путь берётся из строки
 * под замком, а не из прочитанной в начале обработчика. Прежде удаление и
 * отзыв стирали путь, прочитанный до долгой работы, — и загрузка, успевшая
 * закоммититься в промежутке, оставляла свой файл на диске без ссылки на
 * него: строка «удалена», разговор лежит.
 */
async function lockRecording(id: string): Promise<RecordingRow> {
  const [row] = await db.select().from(visitRecordings).where(eq(visitRecordings.id, id)).for("update");
  return row!;
}

/**
 * Принимает ли запись аудио прямо сейчас.
 *
 * Два случая. Первый — запись идёт. Второй — её остановила вторая сторона
 * (пациент со своего телефона): строка в «готово», запись начиналась, файла
 * нет. Аудио при этом у того, кто писал, и прежде дослать его было некуда —
 * остановка с файлом требовала «идёт запись» и отвечала 400, а разговор,
 * записанный с согласия до самой остановки, пропадал.
 *
 * Условие «начата не раньше согласия» отсекает запись, согласие на которую
 * отозвали и дали заново: основание хранить ту запись снято вместе с
 * прежним согласием, и новое согласие его не возвращает.
 *
 * Одно и то же условие — в коде (для внятного отказа) и в SQL (решает оно:
 * см. UPDATE в остановке).
 */
function takesAudio(rec: RecordingRow): boolean {
  if (rec.status === "recording") return true;
  return (
    rec.status === "ready" &&
    !!rec.startedAt &&
    !!rec.endedAt &&
    !rec.audioPath &&
    !!rec.consentAt &&
    new Date(rec.startedAt).getTime() >= new Date(rec.consentAt).getTime()
  );
}

const takesAudioSql = or(
  eq(visitRecordings.status, "recording"),
  and(
    eq(visitRecordings.status, "ready"),
    isNotNull(visitRecordings.startedAt),
    isNotNull(visitRecordings.endedAt),
    isNull(visitRecordings.audioPath),
    isNotNull(visitRecordings.consentAt),
    gte(visitRecordings.startedAt, visitRecordings.consentAt),
  ),
);

/** Ключ отправки придумывает клиент; берём только то, что похоже на ключ */
function uploadKey(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
}

/** Состояние записи: обе стороны смотрят на одно и то же */
recordingRoutes.get("/:appointmentId", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  /*
   * Строка записи заводится при первом обращении — но не в транзакции
   * «только чтение» (вход «от имени», учётка «только просмотр», волна 12):
   * там вставка упала бы в базе. Строки ещё нет — отдаём её начальное
   * состояние, ничего не записав.
   */
  const rec = requestIsReadOnly()
    ? ((await db.query.visitRecordings.findFirst({ where: eq(visitRecordings.appointmentId, visit.id) })) ??
      unsavedRecording(visit.patientId))
    : await recordingFor(visit.id, visit.patientId, visit.specialistId);
  const me = c.get("user");

  return c.json({
    id: rec.id,
    status: rec.status,
    consentAt: rec.consentAt,
    /** Согласие отметил сам пациент или специалист с его слов — это разные вещи */
    consentBySelf: rec.consentBy === rec.patientId,
    startedAt: rec.startedAt,
    durationMs: rec.durationMs,
    /*
     * Стенограмму видит только специалист. Пациенту она не отдаётся: это не
     * его запись о себе, а рабочий материал приёма, и читать её без
     * объяснений — то же, что читать черновик заключения.
     */
    /*
     * Только у завершённой расшифровки. Прежде отдавалась при любом
     * статусе — в том числе у записи, помеченной удалённой: гонка с
     * расшифровщиком могла дописать текст уже после просьбы удалить.
     */
    transcript: isStaff(me) && rec.status === "done" ? decryptField(rec.transcriptEnc) : null,
    transcriptEngine: rec.transcriptEngine,
    failure: rec.failure,
    /*
     * Честно говорим, будет ли расшифровка вообще. Молчание здесь означало бы
     * запись, которая «обрабатывается» третью неделю.
     */
    transcriptionAvailable: transcriptionAvailable(),
    queued: await pendingTranscriptions(),
  });
});

/**
 * Согласие на запись этого приёма.
 *
 * Отмечает либо сам пациент со своего устройства, либо специалист — если
 * пациент согласился голосом, а телефона при себе нет. Кто отметил,
 * сохраняется: «согласился сам» и «записано с его слов» — разные основания, и
 * при разборе разница существенна.
 */
recordingRoutes.post("/:appointmentId/consent", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const rec = await recordingFor(visit.id, visit.patientId, visit.specialistId);
  const me = c.get("user");

  if (rec.consentAt) badRequest("err.recordingConsentAlready");
  if (["done", "uploaded", "transcribing"].includes(rec.status)) {
    badRequest("err.recordingAlready");
  }

  await db
    .update(visitRecordings)
    .set({ consentAt: new Date().toISOString(), consentBy: me.id, status: "ready" })
    .where(eq(visitRecordings.id, rec.id));

  await audit(c, {
    action: "recording.consent",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
    details: { bySelf: me.id === visit.patientId },
  });
  return c.json({ ok: true });
});

/**
 * Отозвать согласие.
 *
 * До начала записи — просто снимает разрешение. Право передумать до того, как
 * что-то сказано, не должно требовать объяснений.
 *
 * Если записать уже успели — аудио стирается тем же движением, что и при
 * удалении. Раньше отзыв менял только отметку согласия, и при состояниях
 * uploaded или transcribing файл оставался лежать на диске: согласия нет, а
 * разговор хранится и вот-вот станет стенограммой. Основание хранить запись —
 * согласие; снято согласие — хранить нечего.
 */
recordingRoutes.post("/:appointmentId/consent/revoke", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const found = await recordingFor(visit.id, visit.patientId, visit.specialistId);
  /*
   * Под замком: начало записи и загрузка аудио ждут, пока отзыв не
   * закончится, а отзыв видит строку такой, какая она есть сейчас. Иначе
   * старт, проскочивший между чтением и обновлением, оставлял «идёт
   * запись» без согласия, а загрузка — файл без ссылки.
   */
  const rec = await lockRecording(found.id);
  if (rec.status === "recording") badRequest("err.recordingInProgress");

  await db
    .update(visitRecordings)
    .set({
      consentAt: null,
      consentBy: null,
      status: "consent_pending",
      // путь обнуляется вместе с файлом: строка, ведущая в никуда, на экране
      // выглядит как «запись есть», а по ней потом пойдёт расшифровка
      audioPath: null,
      audioBytes: null,
      /*
       * И стенограмма — если отзыв застал запись ещё не расшифрованной.
       *
       * Строка `rec` прочитана в начале обработчика, и между чтением и этим
       * UPDATE воркер успевал положить итог: статус «готово», текст в базе.
       * Отзыв обнулял аудио и согласие, а текст оставлял — и разговор, на
       * хранение которого согласия больше нет, лежал в базе буквами.
       * Отзыв, заставший стенограмму уже готовой, её не трогает, как и
       * прежде: это решение о записи в карте, а не о разговоре.
       */
      ...(rec.status === "done" ? {} : { transcriptEnc: null, transcriptEngine: null, transcriptAt: null }),
    })
    .where(eq(visitRecordings.id, rec.id));

  await audit(c, {
    action: "recording.consent_revoke",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
    // было ли что стирать — важно при разборе: «отозвал до записи» и
    // «отозвал, когда разговор уже лежал на диске» — разные события
    details: { hadAudio: !!rec.audioPath, from: rec.status },
  });
  /*
   * Файл — последним, когда строка и журнал уже записаны: сорвись что-то
   * раньше, транзакция откатится, и строка по-прежнему будет вести к файлу,
   * а не в пустоту.
   */
  await eraseAudio(rec.audioPath);
  return c.json({ ok: true });
});

/** Начать. Пишет специалист — со своего устройства он ведёт приём */
recordingRoutes.post("/:appointmentId/start", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const rec = await recordingFor(visit.id, visit.patientId, visit.specialistId);
  /*
   * Начинает запись только специалист.
   *
   * Раньше проверки не было: доступ давала общая `visitOf`, пускающая обе
   * стороны приёма. Комментарий говорил «пишет специалист», код этого не
   * требовал — и пациент мог начать запись сам, а затем передать любой
   * файл (см. остановку ниже).
   */
  if (c.get("user").id !== visit.specialistId) forbidden("err.recordingSpecialistOnly");

  /*
   * Без согласия запись не начинается, и проверяет это сервер.
   *
   * Кнопка на экране тоже спрятана, но полагаться на спрятанную кнопку
   * нельзя: маршрут вызывается напрямую, а цена ошибки здесь — записанный
   * без разрешения разговор о самом личном.
   */
  if (!rec.consentAt) forbidden("err.recordingNoConsent");
  if (rec.status === "recording") badRequest("err.recordingInProgress");
  /*
   * Поверх сохранённого аудио новая запись не начинается. Упавшая
   * расшифровка хранит файл (её повторяют из техпанели), и старт поверх неё
   * прежде проходил: следующая загрузка подменяла прежний разговор другим
   * или оставляла старый файл без ссылки. Одна запись на приём: сначала
   * удалить, потом записывать заново.
   */
  if (["uploaded", "transcribing", "done"].includes(rec.status) || rec.audioPath) {
    badRequest("err.recordingAlready");
  }

  /*
   * Проверки выше — для внятного отказа; решает условие в самом UPDATE.
   *
   * Строка прочитана в начале обработчика, и отзыв согласия, пришедший
   * между чтением и записью, отрабатывал полностью — а безусловный UPDATE
   * всё равно ставил «идёт запись»: 200, status=recording при consent_at =
   * null. То есть запись разговора без согласия, о которой сервер сам
   * говорит «можно». Условие в UPDATE перепроверяется на свежей строке
   * (READ COMMITTED перечитывает её после чужого коммита), и отзыв,
   * успевший первым, запись не пропускает.
   *
   * Конец и ключ прежней отправки сбрасываются: по ним остановка узнаёт,
   * ждёт ли запись аудио и не повтор ли это (см. takesAudio).
   */
  const startedAt = new Date().toISOString();
  const started = await db
    .update(visitRecordings)
    .set({ status: "recording", startedAt, endedAt: null, durationMs: null, uploadId: null })
    .where(
      and(
        eq(visitRecordings.id, rec.id),
        isNotNull(visitRecordings.consentAt),
        notInArray(visitRecordings.status, ["recording", "uploaded", "transcribing", "done"]),
        isNull(visitRecordings.audioPath),
      ),
    )
    .returning({ id: visitRecordings.id });
  if (!started.length) {
    const [now] = await db.select().from(visitRecordings).where(eq(visitRecordings.id, rec.id));
    if (!now?.consentAt) forbidden("err.recordingNoConsent");
    if (now.status === "recording") badRequest("err.recordingInProgress");
    badRequest("err.recordingAlready");
  }

  await audit(c, {
    action: "recording.start",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
  });
  /*
   * Начало возвращается клиенту: по нему браузер узнаёт в опросе состояния
   * именно ЭТУ запись — остановленную пациентом или удалённую, — а не
   * устаревший ответ, отправленный ещё до старта.
   */
  return c.json({ ok: true, startedAt });
});

/**
 * Остановить и передать аудио.
 *
 * Остановить может любая сторона: это разговор двоих. Передаёт аудио тот, кто
 * писал, — обычно специалист; остановка пациентом просто прекращает запись, и
 * тогда сохраняется то, что успело записаться.
 */
recordingRoutes.post("/:appointmentId/stop", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const rec = await recordingFor(visit.id, visit.patientId, visit.specialistId);
  const me = c.get("user");

  /*
   * Тело разбирается до проверки состояния: от него зависит, какое
   * состояние годится. Остановка без файла — только идущей записи; с файлом
   * — ещё и записи, которую остановила вторая сторона (см. takesAudio), и
   * повтор уже принятой отправки. Тело к этому моменту всё равно вычитано
   * целиком (общий bodyLimit), так что порядок ничего не стоит.
   */
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("audio");
  const hasAudio = file instanceof File && file.size > 0;

  /*
   * Файл принимается только от специалиста.
   *
   * Остановить запись вправе обе стороны — это разговор двоих, и пациент
   * должен иметь возможность его прекратить. Но передать аудио — другое
   * действие: без этой проверки пациент вызывал `/start`, затем `/stop` со
   * своим файлом, и подготовленная им запись шифровалась, расшифровывалась
   * и показывалась специалисту как стенограмма ЭТОГО приёма. То есть
   * подделка клинической записи о разговоре, которого не было.
   */
  if (hasAudio && me.id !== visit.specialistId) {
    forbidden("err.recordingSpecialistOnly");
  }

  if (hasAudio) {
    /*
     * Потолок на размер: три часа приёма в сжатом виде — около сотни
     * мегабайт, и всё, что больше, — это не приём, а ошибка клиента или
     * попытка забить диск.
     */
    if (file.size > 200 * 1024 * 1024) badRequest("err.recordingTooLarge");

    /*
     * Повтор уже принятой отправки — «принято», а не отказ.
     *
     * Сеть рвётся и после того, как сервер всё сохранил: ответ до браузера
     * не дошёл, и клиент, который держит запись до подтверждения, шлёт её
     * снова. Прежде он получал 400 «запись не идёт» — специалист видел
     * отказ при сохранённой записи. Ключ отправки клиент придумывает один
     * раз на запись; совпал и файл на месте — это та же отправка.
     */
    const uploadId = uploadKey(form?.get("uploadId"));
    if (uploadId && rec.uploadId === uploadId && rec.audioPath) {
      return c.json({ ok: true, duplicate: true });
    }
    if (!takesAudio(rec)) badRequest("err.recordingNotRunning");

    const bytes = new Uint8Array(await file.arrayBuffer());
    /*
     * Формат — по байтам, при приёме. Прежде сервер брал что угодно, а
     * нечитаемое обнаруживал расшифровщик — часами позже, когда запись в
     * браузере уже стёрта. Отказ здесь оставляет запись «идущей»: у
     * специалиста файл ещё в браузере.
     */
    if (!sniffAudio(bytes)) badRequest("err.recordingFormat");

    const path = await storeAudio(rec.id, bytes);
    /*
     * Состояние проверяется ещё раз — в самом UPDATE.
     *
     * Строка `rec` прочитана в начале обработчика, а между чтением и записью
     * лежит приём файла: часовой разговор — это десятки мегабайт и заметное
     * время. За это время пациент успевает нажать «удалить», и его удаление
     * отрабатывает полностью — файл стёрт, статус discarded. Безусловный
     * UPDATE возвращал запись к жизни: статус uploaded, путь к только что
     * залитому файлу, дальше расшифровка и стенограмма в карте. То есть
     * разговор, который человек попросил удалить, оказывался в карте
     * текстом, и на экране не было ни следа отказа.
     *
     * Путь файла свой у каждой загрузки (storeAudio), поэтому из двух
     * одновременных остановок публикует файл ровно одна — та, чьё условное
     * обновление прошло. Проигравшая стирает только свой файл.
     *
     * Конец записи — момент остановки: у идущей записи это сейчас, у
     * остановленной второй стороной — когда её остановили (он уже в
     * строке). Считается в самом UPDATE по свежей строке, а не по `rec`.
     */
    const now = new Date().toISOString();
    const endedAt = sql<string>`case when ${visitRecordings.status} = 'recording' then ${now}::timestamptz else ${visitRecordings.endedAt} end`;
    const written = await db
      .update(visitRecordings)
      .set({
        status: "uploaded",
        endedAt,
        audioPath: path,
        audioBytes: bytes.byteLength,
        uploadId,
        durationMs: sql<number>`round(extract(epoch from (${endedAt}) - ${visitRecordings.startedAt}) * 1000)::int`,
      })
      .where(and(eq(visitRecordings.id, rec.id), takesAudioSql))
      .returning({ id: visitRecordings.id });
    if (!written.length) {
      // файл уже на диске: без этого от «удалённой» записи оставалось бы
      // на диске всё её содержимое — ровно то, что просили стереть
      await eraseAudio(path);
      /*
       * Проиграли гонку своему же повтору (двойное нажатие, повтор после
       * обрыва, пока первая попытка ещё шла): отправка та же — «принято».
       * Строка перечитывается: UPDATE выше дождался коммита победителя, и
       * новый запрос видит его.
       */
      const [fresh] = await db.select().from(visitRecordings).where(eq(visitRecordings.id, rec.id));
      if (uploadId && fresh?.uploadId === uploadId && fresh.audioPath) {
        return c.json({ ok: true, duplicate: true });
      }
      badRequest("err.recordingGone");
    }
  } else {
    if (rec.status !== "recording") badRequest("err.recordingNotRunning");
    /*
     * Остановили, но аудио не прислали — так бывает, когда останавливает
     * вторая сторона. Запись возвращается в «готово», а не пропадает: у
     * того, кто писал, файл ещё на устройстве, и он его дошлёт (takesAudio
     * принимает его и в «готово»).
     */
    const written = await db
      .update(visitRecordings)
      .set({ status: "ready", endedAt: new Date().toISOString() })
      .where(and(eq(visitRecordings.id, rec.id), eq(visitRecordings.status, "recording")))
      .returning({ id: visitRecordings.id });
    // та же причина, что и у ветки с файлом: разбор тела занимает время,
    // и «готово» вернуло бы к жизни запись, удалённую за это время
    if (!written.length) badRequest("err.recordingGone");
  }

  await audit(c, {
    action: "recording.stop",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
    details: {
      byPatient: me.id === visit.patientId,
      withAudio: hasAudio,
      // аудио дослано после того, как запись остановила вторая сторона
      late: hasAudio && rec.status !== "recording",
    },
  });
  return c.json({ ok: true });
});

/**
 * Удалить запись до расшифровки.
 *
 * Может любая сторона, и объяснений не требуется. Сказанное сгоряча человек
 * вправе забрать назад, пока оно не стало текстом в карте.
 *
 * Файл стирается, строка остаётся: след того, что запись была и её убрали,
 * нужен — иначе исчезновение записи неотличимо от того, что её не делали.
 */
recordingRoutes.post("/:appointmentId/discard", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const found = await recordingFor(visit.id, visit.patientId, visit.specialistId);
  const me = c.get("user");
  /*
   * Под замком — по той же причине, что и отзыв согласия: стирается путь из
   * строки, какой она стала к этому мгновению. Загрузка, закоммиченная
   * между чтением и обновлением, прежде оставляла свой файл на диске при
   * строке «удалена».
   */
  const rec = await lockRecording(found.id);

  if (rec.status === "done") badRequest("err.recordingTranscribed");

  await db
    .update(visitRecordings)
    .set({
      status: "discarded",
      audioPath: null,
      audioBytes: null,
      /*
       * Стенограмма стирается вместе с аудио.
       *
       * Раньше обнулялся только файл. Расшифровка идёт минутами, и если
       * она успела записать текст (или дописала его сразу после), в базе
       * оставался разговор целиком — при том, что человек попросил запись
       * удалить и на экране написано «удалена». Стенограмма — это тот же
       * разговор, только буквами.
       */
      transcriptEnc: null,
      transcriptEngine: null,
      transcriptAt: null,
      discardedAt: new Date().toISOString(),
      discardedBy: me.id,
    })
    .where(eq(visitRecordings.id, rec.id));

  await audit(c, {
    action: "recording.discard",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
    details: { byPatient: me.id === visit.patientId, hadAudio: !!rec.audioPath },
  });
  // файл — последним, как и при отзыве: откат транзакции не должен оставить строку без файла
  await eraseAudio(rec.audioPath);
  return c.json({ ok: true });
});
