import { Hono } from "hono";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import {
  appointments,
  conclusions,
  departments,
  dispensary,
  episodes,
  referrals,
  responses,
  slots,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, notFound, parseBody } from "../lib/http";
import { assertPatientAccess } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Эпизод обслуживания.
 *
 * Приёмы, прохождения, заключения и направления лежали рядом, но не были
 * связаны: чтобы понять, «с чем человек приходил в марте и чем это
 * кончилось», приходилось складывать хронологию в голове. Эпизод делает
 * обращение единицей, у которой есть повод, ход и исход.
 */
export const episodeRoutes = new Hono<AppEnv>();

episodeRoutes.use("*", requireAuth, requireStaff);

const openSchema = z.object({
  patientId: z.string().min(1),
  reason: z.string().max(2000).nullish(),
  departmentId: z.string().nullish(),
});

const closeSchema = z.object({
  outcome: z.string().max(2000).nullish(),
  outcomeKind: z.enum(["improved", "stable", "worse", "referred", "dropped", "transferred"]),
});

/** Обращения человека: открытые сверху, закрытые ниже */
episodeRoutes.get("/patients/:userId", requirePermission("patients.read"), async (c) => {
  const patientId = c.req.param("userId");
  await assertPatientAccess(c.get("user"), patientId);

  const rows = await db
    .select({ e: episodes, lead: users })
    .from(episodes)
    .leftJoin(users, eq(users.id, episodes.leadSpecialistId))
    .where(eq(episodes.patientId, patientId))
    .orderBy(desc(episodes.openedAt))
    .limit(100);

  /*
   * Счётчики считаются здесь, а не на клиенте: «три приёма и два заключения»
   * — это то, ради чего эпизод и заводился, и собирать это тремя запросами с
   * экрана значило бы вернуть человека к складыванию картины в голове.
   */
  const items = [];
  for (const r of rows) {
    const [counts] = await db.execute<{ visits: number; conclusions: number; referrals: number }>(
      sql`select
        (select count(*)::int from appointments a where a.episode_id = ${r.e.id}) as visits,
        (select count(*)::int from conclusions cn where cn.episode_id = ${r.e.id}) as conclusions,
        (select count(*)::int from referrals rf where rf.episode_id = ${r.e.id}) as referrals`,
    );
    items.push({
      id: r.e.id,
      openedAt: r.e.openedAt,
      closedAt: r.e.closedAt,
      reason: decryptField(r.e.reasonEnc),
      outcome: decryptField(r.e.outcomeEnc),
      outcomeKind: r.e.outcomeKind,
      leadName: r.lead ? fullNameOf(r.lead) : null,
      visits: Number(counts?.visits ?? 0),
      conclusions: Number(counts?.conclusions ?? 0),
      referrals: Number(counts?.referrals ?? 0),
    });
  }
  return c.json({ items });
});

/**
 * Открыть обращение.
 *
 * Одно открытое на человека: два одновременных обращения к одному отделению —
 * это не два обращения, а потерянная связь между событиями. Если человек
 * пришёл с новым поводом, прежнее закрывают.
 */
episodeRoutes.post("/", requirePermission("episodes.manage"), async (c) => {
  const input = await parseBody(c.req.raw, openSchema);
  const me = c.get("user");
  await assertPatientAccess(me, input.patientId);

  const [open] = await db
    .select()
    .from(episodes)
    .where(and(eq(episodes.patientId, input.patientId), isNull(episodes.closedAt)));
  if (open) badRequest("err.episodeAlreadyOpen");

  const id = crypto.randomUUID();
  await db.insert(episodes).values({
    id,
    patientId: input.patientId,
    leadSpecialistId: me.id,
    departmentId: input.departmentId ?? null,
    reasonEnc: input.reason ? encryptField(input.reason) : null,
    createdBy: me.id,
  });

  await audit(c, {
    action: "episode.open",
    resourceType: "episode",
    resourceId: id,
    subjectUserId: input.patientId,
  });
  return c.json({ id }, 201);
});

/**
 * Закрыть обращение.
 *
 * Исход обязателен, и не списком, а списком плюс словами: «улучшение» без
 * пояснения через год не читается, а пояснение без разряда не считается.
 */
episodeRoutes.post("/:id/close", requirePermission("episodes.manage"), async (c) => {
  const row = await db.query.episodes.findFirst({ where: eq(episodes.id, c.req.param("id")) });
  if (!row) notFound("err.episodeNotFound");
  await assertPatientAccess(c.get("user"), row.patientId);
  if (row.closedAt) badRequest("err.episodeClosed");

  const input = await parseBody(c.req.raw, closeSchema);
  await db
    .update(episodes)
    .set({
      closedAt: new Date().toISOString(),
      outcomeKind: input.outcomeKind,
      outcomeEnc: input.outcome ? encryptField(input.outcome) : null,
    })
    .where(eq(episodes.id, row.id));

  await audit(c, {
    action: "episode.close",
    resourceType: "episode",
    resourceId: row.id,
    subjectUserId: row.patientId,
    details: { outcomeKind: input.outcomeKind },
  });
  return c.json({ ok: true });
});

/**
 * Привязать приём к обращению.
 *
 * Отдельным действием, а не автоматически при записи: не всякий приём
 * относится к открытому обращению — человек может прийти по другому поводу,
 * и молча подшить это к прежнему значило бы смешать два разных разговора.
 */
episodeRoutes.post("/:id/appointments/:appointmentId", requirePermission("episodes.manage"), async (c) => {
  const row = await db.query.episodes.findFirst({ where: eq(episodes.id, c.req.param("id")) });
  if (!row) notFound("err.episodeNotFound");
  await assertPatientAccess(c.get("user"), row.patientId);

  const visit = await db.query.appointments.findFirst({
    where: eq(appointments.id, c.req.param("appointmentId")),
  });
  if (!visit) notFound("err.appointmentNotFound");
  if (visit.patientId !== row.patientId) badRequest("err.episodeOtherPatient");

  await db
    .update(appointments)
    .set({ episodeId: row.id })
    .where(eq(appointments.id, visit.id));

  await audit(c, {
    action: "episode.attach",
    resourceType: "episode",
    resourceId: row.id,
    subjectUserId: row.patientId,
    details: { appointmentId: visit.id },
  });
  return c.json({ ok: true });
});

/* ═══════════ диспансерное наблюдение ═══════════ */

const dispensarySchema = z.object({
  patientId: z.string().min(1),
  groupLabel: z.string().min(1).max(120),
  intervalMonths: z.number().int().min(1).max(36),
  note: z.string().max(500).nullish(),
});

/** Через сколько месяцев показываться снова */
function dueAfter(months: number, from = new Date()): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/** Состоит ли человек на учёте и когда следующий осмотр */
episodeRoutes.get("/dispensary/:userId", requirePermission("patients.read"), async (c) => {
  const patientId = c.req.param("userId");
  await assertPatientAccess(c.get("user"), patientId);

  const row = await db.query.dispensary.findFirst({
    where: and(eq(dispensary.patientId, patientId), isNull(dispensary.removedAt)),
  });
  if (!row) return c.json({ on: false });

  return c.json({
    on: true,
    groupLabel: row.groupLabel,
    intervalMonths: row.intervalMonths,
    lastSeenAt: row.lastSeenAt,
    nextDueAt: row.nextDueAt,
    note: row.note,
    /*
     * Просрочка считается сервером и отдаётся числом дней, а не флагом:
     * «просрочено на три дня» и «просрочено на полгода» — это разный разговор,
     * а флаг делает их одинаковыми.
     */
    overdueDays: Math.max(
      0,
      Math.floor((Date.now() - new Date(row.nextDueAt).getTime()) / 86_400_000),
    ),
  });
});

/** Поставить на учёт или изменить периодичность */
episodeRoutes.put("/dispensary", requirePermission("episodes.manage"), async (c) => {
  const input = await parseBody(c.req.raw, dispensarySchema);
  const me = c.get("user");
  await assertPatientAccess(me, input.patientId);

  await db
    .insert(dispensary)
    .values({
      patientId: input.patientId,
      groupLabel: input.groupLabel,
      intervalMonths: input.intervalMonths,
      nextDueAt: dueAfter(input.intervalMonths),
      note: input.note ?? null,
      addedBy: me.id,
    })
    .onConflictDoUpdate({
      target: dispensary.patientId,
      set: {
        groupLabel: input.groupLabel,
        intervalMonths: input.intervalMonths,
        note: input.note ?? null,
        /*
         * Постановка заново снимает прежнее снятие: человека вернули на учёт,
         * а не завели вторую запись. Срок считается от сегодня — от даты
         * решения, а не от последнего осмотра, которого могло не быть годы.
         */
        removedAt: null,
        removedBy: null,
        nextDueAt: dueAfter(input.intervalMonths),
      },
    });

  await audit(c, {
    action: "dispensary.set",
    resourceType: "user",
    resourceId: input.patientId,
    subjectUserId: input.patientId,
    details: { group: input.groupLabel, months: input.intervalMonths },
  });
  return c.json({ ok: true });
});

/**
 * Отметить состоявшийся осмотр по учёту.
 *
 * Отдельным действием, а не автоматически по любому приёму: человек мог
 * прийти по другому поводу, и засчитать это за диспансерный осмотр значило бы
 * отодвинуть срок, ничего не проверив.
 */
episodeRoutes.post("/dispensary/:userId/seen", requirePermission("episodes.manage"), async (c) => {
  const patientId = c.req.param("userId");
  await assertPatientAccess(c.get("user"), patientId);

  const row = await db.query.dispensary.findFirst({
    where: and(eq(dispensary.patientId, patientId), isNull(dispensary.removedAt)),
  });
  if (!row) notFound("err.dispensaryNotFound");

  const now = new Date();
  await db
    .update(dispensary)
    .set({ lastSeenAt: now.toISOString(), nextDueAt: dueAfter(row.intervalMonths, now) })
    .where(eq(dispensary.patientId, patientId));

  await audit(c, {
    action: "dispensary.seen",
    resourceType: "user",
    resourceId: patientId,
    subjectUserId: patientId,
  });
  return c.json({ ok: true });
});

/** Снять с учёта. Строка остаётся: снятие — это событие, а не забвение */
episodeRoutes.delete("/dispensary/:userId", requirePermission("episodes.manage"), async (c) => {
  const patientId = c.req.param("userId");
  await assertPatientAccess(c.get("user"), patientId);
  const me = c.get("user");

  const row = await db.query.dispensary.findFirst({
    where: and(eq(dispensary.patientId, patientId), isNull(dispensary.removedAt)),
  });
  if (!row) notFound("err.dispensaryNotFound");

  await db
    .update(dispensary)
    .set({ removedAt: new Date().toISOString(), removedBy: me.id })
    .where(eq(dispensary.patientId, patientId));

  await audit(c, {
    action: "dispensary.remove",
    resourceType: "user",
    resourceId: patientId,
    subjectUserId: patientId,
  });
  return c.json({ ok: true });
});
