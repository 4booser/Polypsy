import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { appointments, slots, users, visitRecordings } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { badRequest, forbidden, notFound, parseBody } from "../lib/http";
import {
  eraseAudio,
  pendingTranscriptions,
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

/** Состояние записи: обе стороны смотрят на одно и то же */
recordingRoutes.get("/:appointmentId", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const rec = await recordingFor(visit.id, visit.patientId, visit.specialistId);
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
    transcript: isStaff(me) ? decryptField(rec.transcriptEnc) : null,
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
 */
recordingRoutes.post("/:appointmentId/consent/revoke", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const rec = await recordingFor(visit.id, visit.patientId, visit.specialistId);
  if (rec.status === "recording") badRequest("err.recordingInProgress");

  await db
    .update(visitRecordings)
    .set({ consentAt: null, consentBy: null, status: "consent_pending" })
    .where(eq(visitRecordings.id, rec.id));

  await audit(c, {
    action: "recording.consent_revoke",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
  });
  return c.json({ ok: true });
});

/** Начать. Пишет специалист — со своего устройства он ведёт приём */
recordingRoutes.post("/:appointmentId/start", async (c) => {
  const visit = await visitOf(c, c.req.param("appointmentId"));
  const rec = await recordingFor(visit.id, visit.patientId, visit.specialistId);

  /*
   * Без согласия запись не начинается, и проверяет это сервер.
   *
   * Кнопка на экране тоже спрятана, но полагаться на спрятанную кнопку
   * нельзя: маршрут вызывается напрямую, а цена ошибки здесь — записанный
   * без разрешения разговор о самом личном.
   */
  if (!rec.consentAt) forbidden("err.recordingNoConsent");
  if (rec.status === "recording") badRequest("err.recordingInProgress");
  if (["uploaded", "transcribing", "done"].includes(rec.status)) badRequest("err.recordingAlready");

  await db
    .update(visitRecordings)
    .set({ status: "recording", startedAt: new Date().toISOString() })
    .where(eq(visitRecordings.id, rec.id));

  await audit(c, {
    action: "recording.start",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
  });
  return c.json({ ok: true });
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
  if (rec.status !== "recording") badRequest("err.recordingNotRunning");

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("audio");

  if (file instanceof File && file.size > 0) {
    /*
     * Потолок на размер: три часа приёма в сжатом виде — около сотни
     * мегабайт, и всё, что больше, — это не приём, а ошибка клиента или
     * попытка забить диск.
     */
    if (file.size > 200 * 1024 * 1024) badRequest("err.recordingTooLarge");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const path = await storeAudio(rec.id, bytes);
    await db
      .update(visitRecordings)
      .set({
        status: "uploaded",
        endedAt: new Date().toISOString(),
        audioPath: path,
        audioBytes: bytes.byteLength,
        durationMs: rec.startedAt ? Date.now() - new Date(rec.startedAt).getTime() : null,
      })
      .where(eq(visitRecordings.id, rec.id));
  } else {
    /*
     * Остановили, но аудио не прислали — так бывает, когда останавливает
     * вторая сторона. Запись возвращается в «готово», а не пропадает: у
     * того, кто писал, файл ещё на устройстве, и он его дошлёт.
     */
    await db
      .update(visitRecordings)
      .set({ status: "ready", endedAt: new Date().toISOString() })
      .where(eq(visitRecordings.id, rec.id));
  }

  await audit(c, {
    action: "recording.stop",
    resourceType: "appointment",
    resourceId: visit.id,
    subjectUserId: visit.patientId,
    details: { byPatient: me.id === visit.patientId, withAudio: file instanceof File },
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
  const rec = await recordingFor(visit.id, visit.patientId, visit.specialistId);
  const me = c.get("user");

  if (rec.status === "done") badRequest("err.recordingTranscribed");

  await eraseAudio(rec.audioPath);
  await db
    .update(visitRecordings)
    .set({
      status: "discarded",
      audioPath: null,
      audioBytes: null,
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
  return c.json({ ok: true });
});
