import { Hono } from "hono";
import { and, asc, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { messages, threads, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, forbidden, notFound, parseBody } from "../lib/http";
import { assertPatientAccess, isStaff } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Переписка пациента со своим специалистом.
 *
 * Асинхронная и с границами, названными на экране, а не в правилах: ответ в
 * рабочее время, это не экстренная связь, в кризис — план безопасности и
 * телефон. Обещание круглосуточного ответа в психологическом отделе опаснее
 * отсутствия переписки вовсе: человек в кризис напишет и будет ждать вместо
 * того, чтобы позвонить.
 */
export const messageRoutes = new Hono<AppEnv>();

messageRoutes.use("*", requireAuth);

const sendSchema = z.object({
  /** Кому — только для специалиста: пациент пишет своему и адресата не выбирает */
  patientId: z.string().nullish(),
  text: z.string().min(1).max(4000),
});

/**
 * Разговор пациента: со своим специалистом и ни с кем больше.
 *
 * Адресата пациент не выбирает. Список специалистов в окне переписки
 * превратил бы её в приёмную, где пишут всем сразу и ждут, кто ответит
 * первым; а отвечать на такое некому — переписку ведёт тот, кто человека
 * ведёт.
 */
async function threadForPatient(patientId: string, specialistId: string) {
  const [existing] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.patientId, patientId), eq(threads.specialistId, specialistId)));
  if (existing) return existing;

  const id = crypto.randomUUID();
  await db.insert(threads).values({ id, patientId, specialistId }).onConflictDoNothing();
  const [created] = await db.select().from(threads).where(eq(threads.id, id));
  if (created) return created;
  // гонка: разговор завёл параллельный запрос — берём его
  const [raced] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.patientId, patientId), eq(threads.specialistId, specialistId)));
  return raced!;
}

/** Свой разговор: у пациента один, у специалиста — список */
messageRoutes.get("/", async (c) => {
  const me = c.get("user");

  if (!isStaff(me)) {
    if (!me.leadSpecialistId) return c.json({ items: [], lead: null });
    const thread = await threadForPatient(me.id, me.leadSpecialistId);
    const lead = await db.query.users.findFirst({ where: eq(users.id, me.leadSpecialistId) });
    return c.json({
      items: [
        {
          id: thread.id,
          withName: lead ? fullNameOf(lead) : "—",
          lastMessageAt: thread.lastMessageAt,
          unread: await unreadCount(thread.id, me.id),
        },
      ],
      lead: me.leadSpecialistId,
    });
  }

  const rows = await db
    .select({ thread: threads, patient: users })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.patientId))
    .where(and(eq(threads.specialistId, me.id), isNull(threads.closedAt)))
    .orderBy(desc(threads.lastMessageAt))
    .limit(200);

  const items = [];
  for (const r of rows) {
    items.push({
      id: r.thread.id,
      withName: fullNameOf(r.patient),
      patientId: r.thread.patientId,
      lastMessageAt: r.thread.lastMessageAt,
      unread: await unreadCount(r.thread.id, me.id),
    });
  }
  return c.json({ items, lead: null });
});

/** Непрочитанное — то, что написал не я и что я ещё не открыл */
async function unreadCount(threadId: string, meId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), ne(messages.authorId, meId), isNull(messages.readAt)));
  return Number(row?.n ?? 0);
}

/** Сам разговор. Открытие помечает чужие сообщения прочитанными */
messageRoutes.get("/:id", async (c) => {
  const me = c.get("user");
  const [thread] = await db.select().from(threads).where(eq(threads.id, c.req.param("id")));
  if (!thread) notFound("err.threadNotFound");
  if (thread.patientId !== me.id && thread.specialistId !== me.id) notFound("err.threadNotFound");

  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, thread.id))
    .orderBy(asc(messages.sentAt))
    .limit(500);

  /*
   * Прочитанным помечается при открытии, а не при отправке ответа.
   *
   * «Прочитано» здесь означает ровно «специалист это видел» — и по нему
   * человек понимает, что письмо не потерялось. Ждать ответа, чтобы
   * поставить отметку, значило бы оставлять его в неведении именно тогда,
   * когда ответ готовится дольше обычного.
   */
  const unreadIds = rows.filter((m) => m.authorId !== me.id && !m.readAt).map((m) => m.id);
  if (unreadIds.length) {
    await db
      .update(messages)
      .set({ readAt: new Date().toISOString() })
      .where(and(eq(messages.threadId, thread.id), ne(messages.authorId, me.id), isNull(messages.readAt)));
  }

  return c.json({
    id: thread.id,
    items: rows.map((m) => ({
      id: m.id,
      mine: m.authorId === me.id,
      text: decryptField(m.textEnc) ?? "",
      sentAt: m.sentAt,
      readAt: m.readAt,
    })),
  });
});

messageRoutes.post("/", async (c) => {
  const me = c.get("user");
  const input = await parseBody(c.req.raw, sendSchema);

  let patientId: string;
  let specialistId: string;

  if (isStaff(me)) {
    if (!input.patientId) badRequest("err.messageRecipientRequired");
    const { hasPermission } = await import("../lib/permissions");
    if (!(await hasPermission(me, "messages.write"))) {
      forbidden("err.permissionRequired", { permission: "messages.write" });
    }
    await assertPatientAccess(me, input.patientId!);
    patientId = input.patientId!;
    specialistId = me.id;
  } else {
    /*
     * Пациент пишет своему специалисту и адресата не выбирает. Нет ведущего —
     * нет и переписки: писать «в отделение» означало бы письмо, за которое
     * никто не отвечает, а такое письмо хуже отсутствия переписки.
     */
    if (!me.leadSpecialistId) badRequest("err.noLeadSpecialist");
    patientId = me.id;
    specialistId = me.leadSpecialistId;
  }

  const thread = await threadForPatient(patientId, specialistId);

  const id = crypto.randomUUID();
  await db.insert(messages).values({
    id,
    threadId: thread.id,
    authorId: me.id,
    textEnc: encryptField(input.text)!,
  });
  await db
    .update(threads)
    .set({ lastMessageAt: new Date().toISOString() })
    .where(eq(threads.id, thread.id));

  await audit(c, {
    action: "message.send",
    resourceType: "thread",
    resourceId: thread.id,
    subjectUserId: patientId,
    details: { length: input.text.length, fromStaff: isStaff(me) },
  });

  return c.json({ id, threadId: thread.id }, 201);
});
