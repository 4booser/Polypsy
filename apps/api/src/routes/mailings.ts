import { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  mailingAnswerSchema,
  mailingInboxQuery,
  mailingInputSchema,
  mailingListQuery,
  mailingUpdateSchema,
  type Mailing,
  type MailingCard,
  type MailingInbox,
  type MailingInboxItem,
  type MailingListItem,
  type MailingListPage,
  type MailingRecipient,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import { mailingRecipients, mailings, patientGroupMembers, users, type MailingRow } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { decryptField, encryptField } from "../lib/crypto";
import { badRequest, conflict, notFound, parseBody, parseQuery } from "../lib/http";
import {
  accessiblePatientIds,
  assertMailingAccess,
  assertPatientGroupAccess,
  isSuperadmin,
} from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Рассылки — сообщение «одному многим» с вариантами ответа (кадры f09, f16,
 * f22 макета: список, форма, меню-шестерня «Відправити / Видалити /
 * Зберегти»).
 *
 * Не переписка. Переписка (/api/messages) — разговор двоих, свободный текст,
 * границы канала названы на экране; она остаётся как есть. Здесь один автор,
 * много получателей, у получателя не поле ввода, а кнопки «Так / Ні / …», и
 * после отправки текст неизменен. Почему это не столбцы в threads/messages —
 * записано в миграции 0083.
 *
 * Два входа с разными правами на одном пути. Персонал заводит, правит,
 * отправляет и читает ответы — под правом mailings.manage, которое ставится
 * на каждый маршрут отдельно, а не `use("*")`: у получателя-пациента здесь
 * свои маршруты (inbox, прочитано, ответ), и общий заслон персонала их бы
 * закрыл. Право получателя — не роль и не справочник, а строка в
 * mailing_recipients: ему видно ровно то, что ему доставили.
 */
export const mailingRoutes = new Hono<AppEnv>();

mailingRoutes.use("*", requireAuth);

/** Заслон персонала — на каждый авторский маршрут, см. заголовок файла */
const staffOnly = [requireStaff, requirePermission("mailings.manage")] as const;

/** Рассылка наружу: тема и текст расшифрованы, остальное как в базе */
function toMailing(row: MailingRow): Mailing {
  return {
    id: row.id,
    authorId: row.authorId,
    title: decryptField(row.titleEnc) ?? "",
    body: decryptField(row.bodyEnc) ?? "",
    options: row.options ?? [],
    status: row.status,
    patientGroupId: row.patientGroupId,
    patientIds: row.patientIds ?? [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    sentAt: row.sentAt,
    hiddenAt: row.hiddenAt,
  };
}

/**
 * Начало текста для строки списка.
 *
 * Режется здесь, а не на экране: список из ста рассылок с полным текстом
 * каждой — это сто расшифрованных писем в ответе ради трёх строк на экране.
 * Граница — по пробелу, чтобы не рвать слово; переводы строк схлопываются:
 * строка списка одна, абзацы в ней не читаются.
 */
const PREVIEW_CHARS = 400;

function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_CHARS) return flat;
  const cut = flat.slice(0, PREVIEW_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * Адресаты черновика — только свои.
 *
 * Группа — своя (assertPatientGroupAccess, чужая отвечает «не найдено»);
 * поимённый список — из зоны видимости, и каждый в нём пациент. Без этого
 * рассылка стала бы способом написать кому угодно по идентификатору, а
 * сотрудник в списке адресатов означал бы, что коллега получит кнопки
 * «Так / Ні» под вопросом, заданным пациентам.
 *
 * Проверяется при сохранении черновика, а не только при отправке: черновик
 * с чужим адресатом — уже намерение, и форма обязана отказать сразу, а не
 * через неделю на кнопке «Відправити».
 */
async function assertAddressees(
  user: User,
  input: { patientGroupId?: string | null; patientIds?: string[] },
): Promise<void> {
  if (input.patientGroupId) await assertPatientGroupAccess(user, input.patientGroupId);

  const ids = [...new Set(input.patientIds ?? [])];
  if (!ids.length) return;

  const visible = await accessiblePatientIds(user);
  for (const id of ids) if (visible !== null && !visible.has(id)) notFound("err.userNotFound");

  const rows = await db.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r.role]));
  for (const id of ids) {
    const role = byId.get(id);
    if (!role) notFound("err.userNotFound");
    if (role !== "user") badRequest("err.assignOnlyToPatient");
  }
}

/**
 * Кому уйдёт рассылка — по НЫНЕШНЕМУ составу группы и НЫНЕШНЕЙ зоне видимости
 * автора, а не по тому, что было при сохранении черновика.
 *
 * Черновик мог пролежать месяц: за это время в группу добавили людей, кого-то
 * перевели в другое отделение. Рассылать по снимку месячной давности значило
 * бы писать тем, кого сотруднику больше видеть не положено, и не писать тем,
 * кого он вчера добавил в группу ради этого письма.
 *
 * Зона считается один раз: она нужна и для группы, и для списка.
 */
async function expandRecipients(user: User, row: MailingRow): Promise<string[]> {
  const candidates = new Set<string>(row.patientIds ?? []);
  if (row.patientGroupId) {
    const members = await db
      .select({ userId: patientGroupMembers.patientId })
      .from(patientGroupMembers)
      .where(eq(patientGroupMembers.groupId, row.patientGroupId));
    for (const m of members) candidates.add(m.userId);
  }
  if (!candidates.size) return [];

  const visible = await accessiblePatientIds(user);
  const inZone = [...candidates].filter((id) => visible === null || visible.has(id));
  if (!inZone.length) return [];

  // сотрудник мог попасть в состав группы только в обход, но обход — не повод писать ему
  const patients = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, inZone), eq(users.role, "user")));
  return patients.map((p) => p.id);
}

/* ═══════════ автор: список, форма, меню-шестерня ═══════════ */

/**
 * Список автора — кадр f09: тема, начало текста, дата; поиск, страницы.
 *
 * Чужих рассылок в выдаче нет — условие по автору стоит в запросе; суперадмин
 * видит все, ему разбирать чужие экраны. Скрытые не показываются, если не
 * попросить `?hidden=1` — тогда показываются ТОЛЬКО они, как `?archived=only`
 * у каталога: «скрытые вперемешку с остальными» не нужны ни одному экрану.
 *
 * Поиск и страницы — в приложении после расшифровки, не в SQL: тема и текст
 * шифруются (см. миграцию 0083), LIKE по шифртексту ничего не найдёт, а
 * открытая копия темы в базе ради поиска повторила бы ошибку, которой в
 * переписке намеренно избежали. Список одного автора — десятки строк, не
 * тысячи; расшифровать их дешевле, чем хранить тему открыто.
 *
 * Порядок: у отправленных — по отправке, у черновиков — по последней правке,
 * свежие сверху. Одна дата на строку, как на макете.
 */
mailingRoutes.get("/", ...staffOnly, async (c) => {
  const user = c.get("user");
  const { q, hidden, limit, offset } = parseQuery(c, mailingListQuery);

  const rows = await db
    .select({
      row: mailings,
      recipientCount: sql<number>`(select count(*)::int from mailing_recipients r
        where r.mailing_id = "mailings"."id")`,
      answeredCount: sql<number>`(select count(*)::int from mailing_recipients r
        where r.mailing_id = "mailings"."id" and r.answer is not null)`,
    })
    .from(mailings)
    .where(
      and(
        isSuperadmin(user) ? undefined : eq(mailings.authorId, user.id),
        hidden ? isNotNull(mailings.hiddenAt) : isNull(mailings.hiddenAt),
      ),
    )
    .orderBy(desc(sql`coalesce(${mailings.sentAt}, ${mailings.updatedAt})`));

  const decrypted = rows.map((r) => {
    const m = toMailing(r.row);
    const item: MailingListItem = {
      id: m.id,
      title: m.title,
      preview: previewOf(m.body),
      status: m.status,
      at: m.sentAt ?? m.updatedAt,
      sentAt: m.sentAt,
      recipientCount: Number(r.recipientCount ?? 0),
      answeredCount: Number(r.answeredCount ?? 0),
    };
    // полный текст нужен только поиску; наружу уходит начало
    return { item, haystack: `${m.title} ${m.body}`.toLowerCase() };
  });
  const matched = q ? decrypted.filter((d) => d.haystack.includes(q)) : decrypted;

  const page: MailingListPage = {
    items: matched.slice(offset, offset + limit).map((d) => d.item),
    total: matched.length,
  };
  return c.json(page);
});

/** «Створити» на кадре f16 — черновик; отправка отдельным действием из меню-шестерни */
mailingRoutes.post("/", ...staffOnly, async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, mailingInputSchema);
  await assertAddressees(user, input);

  const [row] = await db
    .insert(mailings)
    .values({
      id: crypto.randomUUID(),
      authorId: user.id,
      titleEnc: encryptField(input.title)!,
      bodyEnc: encryptField(input.body)!,
      options: input.options,
      patientGroupId: input.patientGroupId ?? null,
      patientIds: [...new Set(input.patientIds)],
    })
    .returning();

  await audit(c, {
    action: "mailing.create",
    resourceType: "mailing",
    resourceId: row!.id,
    details: { options: input.options.length, patientGroupId: row!.patientGroupId, patients: row!.patientIds.length },
  });
  return c.json(toMailing(row!), 201);
});

/* ═══════════ получатель: «Повідомлення» в приложении пациента ═══════════ */

/**
 * Свои рассылки — с непрочитанными и счётчиком для меню.
 *
 * Объявлен раньше `/:id`: Hono сопоставляет по порядку регистрации, и иначе
 * «inbox» ушёл бы обработчику карточки как идентификатор.
 *
 * Только отправленные — черновик получателю не существует (см. политику в
 * 0083: до отправки список адресатов — намерение автора, а не факт). Условие
 * стоит и здесь, а не только в политике строк: тесты и обслуживание ходят в
 * базу владельцем, который политики обходит.
 *
 * Имя автора — левым соединением с запасным «—», а не внутренним: под
 * политикой users пациент видит только свою строку, и внутреннее соединение
 * молча выбросило бы из выдачи все рассылки разом. Пустое имя хуже, чем
 * ничего, но пустой ящик хуже пустого имени.
 */
mailingRoutes.get("/inbox", async (c) => {
  const me = c.get("user");
  const { limit, offset } = parseQuery(c, mailingInboxQuery);
  const mine = and(eq(mailingRecipients.userId, me.id), eq(mailings.status, "sent"));

  const rows = await db
    .select({ r: mailingRecipients, m: mailings, author: users })
    .from(mailingRecipients)
    .innerJoin(mailings, eq(mailings.id, mailingRecipients.mailingId))
    .leftJoin(users, eq(users.id, mailings.authorId))
    .where(mine)
    .orderBy(desc(mailings.sentAt), desc(mailingRecipients.deliveredAt))
    .limit(limit)
    .offset(offset);

  const [counts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) filter (where ${mailingRecipients.readAt} is null)::int`,
    })
    .from(mailingRecipients)
    .innerJoin(mailings, eq(mailings.id, mailingRecipients.mailingId))
    .where(mine);

  const items: MailingInboxItem[] = rows.map((r) => {
    const m = toMailing(r.m);
    return {
      id: m.id,
      title: m.title,
      body: m.body,
      options: m.options,
      authorName: r.author ? fullNameOf(r.author) : "—",
      sentAt: m.sentAt ?? r.r.deliveredAt,
      readAt: r.r.readAt,
      answer: r.r.answer,
      answeredAt: r.r.answeredAt,
    };
  });
  const inbox: MailingInbox = {
    items,
    total: Number(counts?.total ?? 0),
    unread: Number(counts?.unread ?? 0),
  };
  return c.json(inbox);
});

/** Строка доставки получателю — или «не найдено»: чужая рассылка для него не существует */
async function myDelivery(me: User, mailingId: string) {
  const [row] = await db
    .select({ r: mailingRecipients, m: mailings })
    .from(mailingRecipients)
    .innerJoin(mailings, eq(mailings.id, mailingRecipients.mailingId))
    .where(
      and(
        eq(mailingRecipients.mailingId, mailingId),
        eq(mailingRecipients.userId, me.id),
        eq(mailings.status, "sent"),
      ),
    );
  if (!row) notFound("err.mailingNotFound");
  return row;
}

/**
 * Прочитано — при открытии, а не при ответе: как в переписке. «Прочитано»
 * означает ровно «человек это видел», и автор по нему понимает, что письмо
 * дошло, даже если отвечать на него нечем (рассылка без вариантов).
 * Повторный вызов ничего не меняет: первая отметка — правда, вторая — нет.
 */
mailingRoutes.post("/:id/read", async (c) => {
  const me = c.get("user");
  const { r } = await myDelivery(me, c.req.param("id"));
  if (r.readAt) return c.json({ readAt: r.readAt });

  const [updated] = await db
    .update(mailingRecipients)
    .set({ readAt: new Date().toISOString() })
    .where(and(eq(mailingRecipients.mailingId, r.mailingId), eq(mailingRecipients.userId, me.id)))
    .returning({ readAt: mailingRecipients.readAt });
  return c.json({ readAt: updated?.readAt ?? null });
});

/**
 * Ответ — один раз.
 *
 * Не «последний ответ побеждает»: автор читает счётчики по вариантам как
 * итог опроса, и человек, нажавший «Так», а через час «Ні», двигал бы этот
 * итог туда-сюда, пока автор на него смотрит. Передумавший пишет
 * специалисту — переписка для этого и есть.
 *
 * Условие «ещё не отвечал» стоит и в самом UPDATE, а не только в проверке
 * выше: два нажатия подряд приходят двумя запросами, и оба прошли бы
 * проверку до того, как первый успел записаться. Ноль обновлённых строк —
 * значит, кто-то успел раньше, и это тот же отказ.
 */
mailingRoutes.post("/:id/answer", async (c) => {
  const me = c.get("user");
  const { r, m } = await myDelivery(me, c.req.param("id"));
  const input = await parseBody(c.req.raw, mailingAnswerSchema);

  const options = m.options ?? [];
  if (!options.length) badRequest("err.mailingNoOptions");
  if (input.answer >= options.length) badRequest("err.mailingBadAnswer");
  if (r.answer !== null) conflict("err.mailingAlreadyAnswered");

  const now = new Date().toISOString();
  const [updated] = await db
    .update(mailingRecipients)
    .set({ answer: input.answer, answeredAt: now, readAt: sql`coalesce(${mailingRecipients.readAt}, ${now})` })
    .where(
      and(
        eq(mailingRecipients.mailingId, r.mailingId),
        eq(mailingRecipients.userId, me.id),
        isNull(mailingRecipients.answer),
      ),
    )
    .returning({ answer: mailingRecipients.answer, answeredAt: mailingRecipients.answeredAt });
  if (!updated) conflict("err.mailingAlreadyAnswered");

  await audit(c, {
    action: "mailing.answer",
    resourceType: "mailing",
    resourceId: r.mailingId,
    subjectUserId: me.id,
    details: { answer: input.answer },
  });
  return c.json(updated);
});

/* ═══════════ автор: карточка и действия меню-шестерни ═══════════ */

/**
 * Карточка рассылки. У отправленной — счётчики по вариантам и получатели.
 *
 * Счётчики считаются по ВСЕМ получателям, имена показываются только тем, кто
 * сейчас в зоне видимости читателя. Это не рассогласование, а два разных
 * вопроса: «сколько ответили „Так“» — факт о рассылке, и он не должен
 * меняться оттого, что одного из ответивших перевели в другое отделение;
 * «кто именно» — персональные данные, и на них действует та же зона, что
 * на составе группы пациентов. Ноль имён при пяти ответах — честнее, чем
 * «Так: 4», которое назавтра станет «Так: 3» без единого нового ответа.
 */
mailingRoutes.get("/:id", ...staffOnly, async (c) => {
  const user = c.get("user");
  const row = await assertMailingAccess(user, c.req.param("id"));
  const mailing = toMailing(row);

  let counts: MailingCard["counts"] = null;
  let answers: MailingCard["answers"] = null;
  let recipients: MailingCard["recipients"] = null;

  if (row.status === "sent") {
    const delivered = await db
      .select({ r: mailingRecipients, person: users })
      .from(mailingRecipients)
      .innerJoin(users, eq(users.id, mailingRecipients.userId))
      .where(eq(mailingRecipients.mailingId, row.id));

    counts = {
      recipients: delivered.length,
      read: delivered.filter((d) => d.r.readAt).length,
      answered: delivered.filter((d) => d.r.answer !== null).length,
    };
    answers = mailing.options.map((text, index) => ({
      index,
      text,
      count: delivered.filter((d) => d.r.answer === index).length,
    }));

    const visible = await accessiblePatientIds(user);
    recipients = delivered
      .filter((d) => visible === null || visible.has(d.r.userId))
      .map(
        (d): MailingRecipient => ({
          userId: d.r.userId,
          fullName: fullNameOf(d.person),
          deliveredAt: d.r.deliveredAt,
          readAt: d.r.readAt,
          answer: d.r.answer,
          answeredAt: d.r.answeredAt,
        }),
      )
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  // карточка с ответами — поимённый список людей, как карточка группы
  await audit(c, {
    action: "mailing.read",
    resourceType: "mailing",
    resourceId: row.id,
    details: { status: row.status, recipients: recipients?.length ?? 0 },
  });

  const card: MailingCard = { ...mailing, counts, answers, recipients };
  return c.json(card);
});

/**
 * «Зберегти» — правка черновика.
 *
 * Отправленная не правится, и это главное правило рассылки: получатели
 * ответили на конкретный текст, и правка после отправки означала бы, что
 * «Так» одних относится к одному вопросу, а «Так» других — к другому, и
 * счётчик по вариантам складывал бы ответы на разные вопросы. Отказ — 409,
 * состояние, а не форма: текст в запросе может быть безупречен.
 */
mailingRoutes.patch("/:id", ...staffOnly, async (c) => {
  const user = c.get("user");
  const row = await assertMailingAccess(user, c.req.param("id"));
  if (row.status === "sent") conflict("err.mailingAlreadySent");

  const input = await parseBody(c.req.raw, mailingUpdateSchema);
  await assertAddressees(user, input);

  const changes = {
    ...(input.title !== undefined && { titleEnc: encryptField(input.title)! }),
    ...(input.body !== undefined && { bodyEnc: encryptField(input.body)! }),
    ...(input.options !== undefined && { options: input.options }),
    ...(input.patientGroupId !== undefined && { patientGroupId: input.patientGroupId ?? null }),
    ...(input.patientIds !== undefined && { patientIds: [...new Set(input.patientIds)] }),
  };
  // пустое тело — не ошибка и не пустой UPDATE (drizzle на нём падает)
  if (Object.keys(changes).length === 0) return c.json(toMailing(row));

  const [updated] = await db
    .update(mailings)
    .set({ ...changes, updatedAt: new Date().toISOString() })
    .where(and(eq(mailings.id, row.id), eq(mailings.status, "draft")))
    .returning();
  // между проверкой и записью рассылку успели отправить — тот же отказ
  if (!updated) conflict("err.mailingAlreadySent");

  await audit(c, {
    action: "mailing.update",
    resourceType: "mailing",
    resourceId: row.id,
    details: { fields: Object.keys(changes) },
  });
  return c.json(toMailing(updated));
});

/**
 * «Відправити».
 *
 * Адресаты разворачиваются в строки mailing_recipients по нынешнему составу
 * и нынешней зоне (см. expandRecipients). Ноль адресатов — отказ, а не тихий
 * успех: «відправлено» никому специалист прочитает как сделанную работу.
 *
 * Строки получателей и смена состояния — одной транзакцией: иначе возможна
 * половина — рассылка «отправлена», а получателей нет (или наоборот), и обе
 * половины выглядят рабочими по отдельности. Условие `status = 'draft'` в
 * самом UPDATE закрывает двойное нажатие: второй запрос увидит ноль строк.
 *
 * В журнал — дважды: сводкой с числом адресатов и поимённо, как у назначения
 * на группу. Пуш уходит фоновым проходом (lib/mailingPush.ts), не отсюда:
 * маршрут живёт в транзакции запроса, и сеть внутри неё держала бы
 * соединение из пула на всё время рассылки.
 */
mailingRoutes.post("/:id/send", ...staffOnly, async (c) => {
  const user = c.get("user");
  const row = await assertMailingAccess(user, c.req.param("id"));
  if (row.status === "sent") conflict("err.mailingAlreadySent");

  const targets = await expandRecipients(user, row);
  if (!targets.length) badRequest("err.mailingNoRecipients");

  const sentAt = new Date().toISOString();
  const sent = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(mailings)
      .set({ status: "sent", sentAt, updatedAt: sentAt })
      .where(and(eq(mailings.id, row.id), eq(mailings.status, "draft")))
      .returning({ id: mailings.id });
    if (!updated) return false;
    await tx
      .insert(mailingRecipients)
      .values(targets.map((userId) => ({ mailingId: row.id, userId, deliveredAt: sentAt })));
    return true;
  });
  if (!sent) conflict("err.mailingAlreadySent");

  await audit(c, {
    action: "mailing.send",
    resourceType: "mailing",
    resourceId: row.id,
    details: { recipients: targets.length, patientGroupId: row.patientGroupId, options: (row.options ?? []).length },
  });
  for (const userId of targets) {
    await audit(c, {
      action: "mailing.deliver",
      resourceType: "mailing",
      resourceId: row.id,
      subjectUserId: userId,
    });
  }

  return c.json({ id: row.id, status: "sent" as const, sentAt, recipients: targets.length });
});

/**
 * «Видалити» — только черновик.
 *
 * Отправленную удалить нельзя: её уже читали и на неё отвечали, и строка
 * получателя с ответом — не только запись автора, но и запись о человеке
 * («что ему присылали и что он ответил»). Удаление стёрло бы её каскадом у
 * всех получателей разом — и из их ящика тоже, — а журнал показывал бы
 * ответы на рассылку, которой нет. Поэтому отправленная у автора СКРЫВАЕТСЯ
 * (POST /:id/hide): с глаз — да, из истории — нет. Отказ — 409 с отдельным
 * кодом, чтобы экран мог предложить «приховати» вместо «видалити».
 */
mailingRoutes.delete("/:id", ...staffOnly, async (c) => {
  const user = c.get("user");
  const row = await assertMailingAccess(user, c.req.param("id"));
  if (row.status === "sent") conflict("err.mailingSentNotDeletable");

  const deleted = await db
    .delete(mailings)
    .where(and(eq(mailings.id, row.id), eq(mailings.status, "draft")))
    .returning({ id: mailings.id });
  if (!deleted.length) conflict("err.mailingSentNotDeletable");

  await audit(c, {
    action: "mailing.delete",
    resourceType: "mailing",
    resourceId: row.id,
    details: { title: decryptField(row.titleEnc) },
  });
  return c.body(null, 204);
});

/** Скрыть у автора — замена удалению для отправленной, см. DELETE выше */
mailingRoutes.post("/:id/hide", ...staffOnly, async (c) => {
  const user = c.get("user");
  const row = await assertMailingAccess(user, c.req.param("id"));
  const [updated] = await db
    .update(mailings)
    .set({ hiddenAt: row.hiddenAt ?? new Date().toISOString() })
    .where(eq(mailings.id, row.id))
    .returning();
  await audit(c, { action: "mailing.hide", resourceType: "mailing", resourceId: row.id });
  return c.json(toMailing(updated!));
});

mailingRoutes.post("/:id/unhide", ...staffOnly, async (c) => {
  const user = c.get("user");
  const row = await assertMailingAccess(user, c.req.param("id"));
  const [updated] = await db
    .update(mailings)
    .set({ hiddenAt: null })
    .where(eq(mailings.id, row.id))
    .returning();
  await audit(c, { action: "mailing.unhide", resourceType: "mailing", resourceId: row.id });
  return c.json(toMailing(updated!));
});
