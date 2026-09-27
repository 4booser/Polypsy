import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db";
import { requestIsReadOnly } from "../db/context";
import { messages, threads, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { namesOf } from "../lib/names";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, forbidden, notFound, parseBody, parseQuery } from "../lib/http";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { assertPatientAccess, isStaff } from "../lib/scope";
import { requireAuth, type AppEnv } from "../middleware/auth";

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
async function existingThread(patientId: string, specialistId: string) {
  const [existing] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.patientId, patientId), eq(threads.specialistId, specialistId)));
  return existing ?? null;
}

async function threadForPatient(patientId: string, specialistId: string) {
  const existing = await existingThread(patientId, specialistId);
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
    /*
     * Разговор заводится при первом открытии — но не в транзакции «только
     * чтение» (вход «от имени», учётка «только просмотр»): там запись упала
     * бы в базе. Разговора ещё нет — список пуст, заведёт его первое письмо.
     */
    const thread = requestIsReadOnly()
      ? await existingThread(me.id, me.leadSpecialistId)
      : await threadForPatient(me.id, me.leadSpecialistId);
    if (!thread) return c.json({ items: [], lead: me.leadSpecialistId });
    /*
     * Имя ведущего — системной ролью (lib/names.ts): строку специалиста
     * пациенту политика users не показывает, и под ролью приложения вместо
     * имени стояло «—» (волна 13, обход под ролью приложения).
     */
    const lead = (await namesOf([me.leadSpecialistId])).get(me.leadSpecialistId);
    return c.json({
      items: [
        {
          id: thread.id,
          withName: lead ?? "—",
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

/**
 * Разговор, в котором состоит спрашивающий; иначе «не найдено».
 */
async function threadOf(id: string, meId: string) {
  const [thread] = await db.select().from(threads).where(eq(threads.id, id));
  if (!thread) notFound("err.threadNotFound");
  if (thread.patientId !== meId && thread.specialistId !== meId) notFound("err.threadNotFound");
  return thread;
}

/** Страница разговора: сколько писем по умолчанию и не больше какого числа */
const PAGE = 100;
const threadQuery = z.object({
  /** Курсор «раньше этого письма» — из nextBefore предыдущей страницы */
  before: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * Сам разговор — ПОСЛЕДНИЕ письма, с курсором назад.
 *
 * Отдавались первые пятьсот по возрастанию времени, без продолжения: с
 * пятьсот первого письма разговор переставал показывать новые — человек
 * писал и не видел своего письма, специалист не видел ответа. И открытие
 * помечало прочитанными ВСЕ письма разговора, в том числе те, что в ответ
 * не попали (волна 12, ревью: вернулось 500, прочитанными стали 501).
 *
 * Теперь страница — последние письма (внутри — по возрастанию, как их
 * читают), nextBefore ведёт к более ранним. Чтение отметок не ставит:
 * «прочитано» — отдельное действие (POST /:id/read) и только для писем,
 * которые клиент показал. Так чтение остаётся чтением: его можно отдать
 * входу «от имени» и учётке «только просмотр», не отмечая ничего за
 * человека.
 */
messageRoutes.get("/:id", async (c) => {
  const me = c.get("user");
  const thread = await threadOf(c.req.param("id"), me.id);
  const { before, limit = PAGE } = parseQuery(c, threadQuery);
  const cursor = decodeCursor(before);

  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.threadId, thread.id),
        // пара «время и идентификатор»: письма одной миллисекунды не теряются на границе страницы
        cursor ? sql`(${messages.sentAt}, ${messages.id}) < (${cursor.at}::timestamptz, ${cursor.id})` : undefined,
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse();

  return c.json({
    id: thread.id,
    items: page.map((m) => ({
      id: m.id,
      mine: m.authorId === me.id,
      text: decryptField(m.textEnc) ?? "",
      sentAt: m.sentAt,
      readAt: m.readAt,
    })),
    hasMore,
    nextBefore: hasMore && page[0] ? encodeCursor(page[0].sentAt, page[0].id) : null,
  });
});

const readSchema = z.object({
  /** Письма, которые клиент показал человеку */
  ids: z.array(z.string().min(1).max(64)).min(1).max(500),
});

/**
 * «Прочитано» — только показанное.
 *
 * Прочитанным помечается при открытии, а не при ответе: «прочитано» значит
 * «специалист это видел», и по нему человек понимает, что письмо не
 * потерялось. Но видел — ровно то, что клиент показал: отметка ставится по
 * списку показанных писем, а не «всему разговору». Отдельным POST, а не
 * побочным действием чтения: вход «от имени» и учётка «только просмотр»
 * запись не выполняют (сторож метода в requireAuth и READ ONLY транзакции),
 * и суперадмин, открыв переписку глазами врача, больше не помечает её
 * прочитанной за врача.
 */
messageRoutes.post("/:id/read", async (c) => {
  const me = c.get("user");
  const thread = await threadOf(c.req.param("id"), me.id);
  const { ids } = await parseBody(c.req.raw, readSchema);
  const marked = await db
    .update(messages)
    .set({ readAt: new Date().toISOString() })
    .where(
      and(
        eq(messages.threadId, thread.id),
        inArray(messages.id, ids),
        // своё письмо прочитанным не становится от того, что я его видел
        ne(messages.authorId, me.id),
        isNull(messages.readAt),
      ),
    )
    .returning({ id: messages.id });
  return c.json({ marked: marked.length });
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
