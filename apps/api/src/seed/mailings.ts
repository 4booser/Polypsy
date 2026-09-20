import { eq } from "drizzle-orm";
import { db } from "../db";
import {
  mailingRecipients,
  mailings,
  patientGroupFavourites,
  patientGroupMembers,
  patientGroups,
  users,
} from "../db/schema";
import { toPublicUser } from "../lib/auth";
import { encryptField } from "../lib/crypto";
import { accessiblePatientIds } from "../lib/scope";

/**
 * Посев волны 5: рассылки и «обрана» группа — чтобы раздел «Повідомлення» и
 * вкладки групп на стенде не были пустыми.
 *
 * Отдельным модулем, а не абзацем в seed.ts: тот файл — тысяча триста строк,
 * и каждая волна дописывала в него свой кусок; параллельные пакеты волны
 * сходятся на нём слиянием, и два абзаца в одном месте — гарантированный
 * конфликт. Модуль зовётся одной строкой в конце seed.ts.
 *
 * Адресаты берутся из НАСТОЯЩЕЙ зоны видимости психолога (lib/scope.ts), а
 * не из списка имён: посев не должен знать, кого сотрудник вправе видеть, —
 * иначе стенд показывал бы рассылку людям, которых маршрут отправки никогда
 * бы не выбрал, и экран лгал бы о том, как работает система.
 *
 * Идемпотентен: есть хоть одна рассылка — ничего не делает.
 */
export async function seedMailings(): Promise<void> {
  const existing = await db.select({ id: mailings.id }).from(mailings).limit(1);
  if (existing.length) return;

  const psy = await db.query.users.findFirst({ where: eq(users.email, "psy@quizzy.dev") });
  if (!psy) return;

  const visible = await accessiblePatientIds(toPublicUser(psy));
  const patients = await db.select({ id: users.id }).from(users).where(eq(users.role, "user"));
  const recipients = patients.map((p) => p.id).filter((id) => visible === null || visible.has(id)).slice(0, 8);
  if (!recipients.length) return;

  /*
   * «Обрана» группа — только если у психолога ещё нет ни одной: посев не
   * трогает то, что человек завёл руками. Закладка ставится ей же — так на
   * стенде видно, что вкладка «обрана» встаёт первой.
   */
  const [ownGroup] = await db
    .select({ id: patientGroups.id })
    .from(patientGroups)
    .where(eq(patientGroups.ownerId, psy.id))
    .limit(1);
  let groupId = ownGroup?.id ?? null;
  if (!groupId) {
    groupId = crypto.randomUUID();
    await db.insert(patientGroups).values({
      id: groupId,
      title: "Група ризику",
      description: "Чи є зараз думки про те, щоб заподіяти собі шкоду?",
      color: "#7c3aed",
      position: 0,
      ownerId: psy.id,
    });
    await db
      .insert(patientGroupMembers)
      .values(recipients.map((patientId) => ({ groupId: groupId!, patientId, addedBy: psy.id })))
      .onConflictDoNothing();
  }
  await db.insert(patientGroupFavourites).values({ userId: psy.id, groupId }).onConflictDoNothing();

  const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600_000).toISOString();

  /* отправленная с вариантами: половина ответила, часть открыла */
  const asked = crypto.randomUUID();
  await db.insert(mailings).values({
    id: asked,
    authorId: psy.id,
    titleEnc: encryptField("Повторний замір настрою: чи готові пройти цього тижня?")!,
    bodyEnc: encryptField(
      "Доброго дня! Минуло три місяці від першого обстеження. Прошу пройти коротку анкету настрою " +
        "цього тижня — це займе близько десяти хвилин. Якщо зараз незручно, оберіть «Пізніше», і я " +
        "нагадаю наступного тижня.",
    )!,
    options: ["Так", "Ні", "Пізніше"],
    status: "sent",
    patientGroupId: groupId,
    patientIds: [],
    createdAt: daysAgo(4),
    updatedAt: daysAgo(3),
    sentAt: daysAgo(3),
  });
  await db.insert(mailingRecipients).values(
    recipients.map((userId, i) => ({
      mailingId: asked,
      userId,
      deliveredAt: daysAgo(3),
      readAt: i % 3 === 2 ? null : daysAgo(2),
      answer: i % 3 === 2 ? null : i % 3,
      answeredAt: i % 3 === 2 ? null : daysAgo(2),
    })),
  );

  /* отправленное уведомление без вариантов — просто прочитать */
  const notice = crypto.randomUUID();
  await db.insert(mailings).values({
    id: notice,
    authorId: psy.id,
    titleEnc: encryptField("Графік прийому на наступний тиждень")!,
    bodyEnc: encryptField(
      "У понеділок і вівторок прийом з 9:00 до 12:00, у середу — з 14:00 до 17:00. У четвер прийому " +
        "не буде. Записатися можна в застосунку.",
    )!,
    options: [],
    status: "sent",
    patientGroupId: null,
    patientIds: recipients,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    sentAt: daysAgo(1),
  });
  await db.insert(mailingRecipients).values(
    recipients.map((userId, i) => ({
      mailingId: notice,
      userId,
      deliveredAt: daysAgo(1),
      readAt: i % 2 ? daysAgo(0) : null,
    })),
  );

  /* черновик — виден в списке автора, получателям не существует */
  await db.insert(mailings).values({
    id: crypto.randomUUID(),
    authorId: psy.id,
    titleEnc: encryptField("Зустріч групи підтримки у п'ятницю")!,
    bodyEnc: encryptField("Нагадую про зустріч групи підтримки у п'ятницю о 16:00, кабінет 214. Чи будете?")!,
    options: ["Буду", "Не зможу"],
    status: "draft",
    patientGroupId: groupId,
    patientIds: [],
  });

  console.log(`  рассылки: 2 отправленные (${recipients.length} адресатов), 1 черновик; «обрана» группа`);
}
