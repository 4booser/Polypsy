import { Hono } from "hono";
import { and, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { t, type WorkKind } from "@quizzy/shared";
import { db } from "../db";
import {
  appointments,
  dispensary,
  batteries,
  batteryAssignments,
  referrals,
  slots,
  threads,
  surveyAccess,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { FOLLOWUP_NOTE } from "../lib/followup";
import { fullNameOf } from "../lib/auth";
import { recentAlertPatients } from "../lib/noShow";
import { langOf } from "../lib/http";
import { accessiblePatientIds, } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Что от меня ждут сегодня.
 *
 * Входящее рассыпано по трём экранам: случаи риска, незакрытые назначения,
 * открытые направления. Дежурный, чтобы понять объём работы, обходит их по
 * очереди и держит картину в голове — а держать её в голове он не обязан.
 *
 * Здесь всё в одном списке, отсортированном по срочности. Не подмена тех
 * экранов: там разбирают, здесь видят, за что взяться.
 */
export const worklistRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 */
worklistRoutes.use("*", requireAuth, requireStaff, requirePermission("patients.read"));

/** Список видов один на сервер и консоль — см. WorkKind */
type Kind = WorkKind;

interface Item {
  kind: Kind;
  id: string;
  userId: string;
  userName: string;
  unit: string | null;
  title: string;
  /*
   * Подробности структурой, а не готовой строкой.
   *
   * Сервер собирал «Срочно · сигналов 3» текстом — и такую строку клиент не
   * может ни перевести, ни переформатировать. Отображение принадлежит
   * клиенту; сервер отдаёт факты.
   */
  severity?: "moderate" | "severe";
  signals?: number;
  /** Сколько дней просрочки или без движения */
  days?: number;
  /** Куда направлен — для направлений */
  destination?: string;
  /** Просрочено по своему правилу: у случая — эскалация, у назначения — срок */
  overdue: boolean;
  /** Кому назначено; null — никому */
  assignedTo: string | null;
  since: string;
  /** Куда вести по нажатию */
  href: string;
}

/*
 * Порядок один на все виды работы: сначала просроченное, потом тяжёлое,
 * потом по давности. Без общего правила список превратился бы в три списка,
 * склеенных подряд, — то есть в то же самое, от чего уходим.
 */
const KIND_WEIGHT: Record<Kind, number> = {
  /*
   * Неявка идёт сразу за случаем риска, а не в конце.
   *
   * Соблазн положить её к остальному велик: формально это всего лишь
   * несостоявшаяся встреча. Но в психологическом отделе переставший
   * приходить — это чаще ухудшение, чем потеря интереса, и чем позже это
   * заметят, тем меньше от этого пользы.
   */
  noshow: 1,
  /*
   * Непрочитанное письмо стоит выше маршрутов и целей, но ниже неявки.
   *
   * Человек, который написал, ждёт ответа и знает, что письмо доставлено —
   * ждать он будет до тех пор, пока не решит, что о нём забыли. Но неявка
   * важнее: там человек не написал ничего, и молчание — это и есть сигнал.
   */
  message: 2,
  /*
   * Просроченный диспансерный осмотр идёт после письма, но раньше повторов:
   * человек на учёте не написал и не пришёл — и это молчание, а не отсутствие
   * повода.
   */
  dispensary: 3,
  followup: 4,
  referral: 5,
  assignment: 6,
};

worklistRoutes.get("/", async (c) => {
  const user = c.get("user");
  // язык читателя: t() без него отдаёт украинский всегда
  const lang = langOf(c);
  const items: Item[] = [];
  const now = Date.now();

  /*
   * Случаи риска в очередь НЕ идут, и это разведение, а не потеря.
   *
   * Они шли сюда наравне с неявками и непрочитанным — и рядом в рельсе
   * стоял отдельный пункт «Случаи риска» с тем же содержимым. Оба
   * показывали одно число, оба вели к одним людям, и выбрать между ними
   * было невозможно: два входа в одно место читаются как два разных места,
   * и человек ходит в оба, чтобы убедиться, что не пропустил.
   *
   * Разбор случая — не «дело на сегодня», а работа со своими правилами:
   * взять на себя, зафиксировать исход, увидеть все сигналы человека
   * разом. Для неё есть свой экран, и очередь на него ссылается, а не
   * пересказывает его.
   */

  /*
   * 2. Неявки.
   *
   * Свои, а не всего отделения: приём — это отношение между двумя людьми, и
   * звонить не пришедшему должен тот, к кому он не пришёл. Отсюда же и
   * область: фильтр по методикам групп здесь ни при чём, приём с методиками
   * не связан вовсе.
   *
   * Берутся только неразобранные — те, где после неявки ничего не сделали:
   * не перезаписали и не отметили, что человек всё-таки был.
   */
  const noShowRows = await db
    .select({
      a: appointments,
      slot: slots,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      unit: users.unit,
      /* сколько раз подряд не приходил: «второй раз подряд» — другой разговор */
      streak: sql<number>`(
        select count(*)::int from appointments prev
        join slots ps on ps.id = prev.slot_id
        where prev.patient_id = ${appointments.patientId}
          and prev.specialist_id = ${appointments.specialistId}
          and prev.status = 'no_show'
          and ps.starts_at > now() - interval '90 days'
      )`,
    })
    .from(appointments)
    .innerJoin(slots, eq(slots.id, appointments.slotId))
    .innerJoin(users, eq(users.id, appointments.patientId))
    .where(
      and(
        eq(appointments.specialistId, user.id),
        eq(appointments.status, "no_show"),
        sql`${slots.startsAt} > now() - interval '30 days'`,
        // разобранной считается неявка, после которой человек снова записан
        sql`not exists (
          select 1 from appointments later
          join slots ls on ls.id = later.slot_id
          where later.patient_id = ${appointments.patientId}
            and later.status <> 'cancelled'
            and ls.starts_at > ${slots.startsAt}
        )`,
      ),
    )
    .limit(200);

  const alerted = await recentAlertPatients(noShowRows.map((r) => r.a.patientId));

  for (const r of noShowRows) {
    items.push({
      kind: "noshow",
      id: r.a.id,
      userId: r.a.patientId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: t({ uk: "Не прийшов на прийом", ru: "Не пришёл на приём" } as never, lang),
      signals: Number(r.streak),
      days: Math.max(0, Math.round((now - new Date(r.slot.startsAt).getTime()) / 86_400_000)),
      /*
       * Срочной неявка становится, если за последний месяц у человека
       * срабатывала тревога риска: тогда «перестал приходить» и «стало
       * хуже» — одно событие, увиденное с разных сторон.
       */
      overdue: alerted.has(r.a.patientId),
      assignedTo: r.a.specialistId,
      since: r.slot.startsAt,
      href: `/patients/${r.a.patientId}`,
    });
  }

  /*
   * 3. Непрочитанные письма.
   *
   * В общую очередь, а не отдельным местом, куда надо не забыть зайти.
   * Отдельный экран переписки означал бы, что письмо ждёт ровно столько,
   * сколько специалист не вспоминал о нём, — а вспоминают о таких экранах
   * в конце дня.
   */
  const unreadRows = await db
    .select({
      thread: threads,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      unit: users.unit,
      unread: sql<number>`(
        select count(*)::int from messages m
        where m.thread_id = ${threads.id} and m.author_id <> ${user.id} and m.read_at is null
      )`,
      oldest: sql<string>`(
        select min(m.sent_at) from messages m
        where m.thread_id = ${threads.id} and m.author_id <> ${user.id} and m.read_at is null
      )`,
    })
    .from(threads)
    .innerJoin(users, eq(users.id, threads.patientId))
    .where(and(eq(threads.specialistId, user.id), isNull(threads.closedAt)))
    .limit(200);

  for (const r of unreadRows) {
    if (Number(r.unread) === 0) continue;
    const waitingDays = r.oldest
      ? Math.floor((now - new Date(r.oldest).getTime()) / 86_400_000)
      : 0;
    items.push({
      kind: "message",
      id: r.thread.id,
      userId: r.thread.patientId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: t({ uk: "Непрочитане повідомлення", ru: "Непрочитанное сообщение" } as never, lang),
      signals: Number(r.unread),
      days: waitingDays,
      /*
       * Просроченным письмо считается через сутки. Ответ обещан в рабочее
       * время, и сутки — это уже «завтра», то есть срок, о котором человеку
       * говорили, прошёл.
       */
      overdue: waitingDays >= 1,
      assignedTo: user.id,
      since: r.oldest ?? r.thread.lastMessageAt,
      href: `/messages/${r.thread.id}`,
    });
  }

  /*
   * 4. Просроченные диспансерные осмотры.
   *
   * Учёт держали в голове и в бумажном журнале — и теряли: просрочка не была
   * видна никому, пока кто-нибудь случайно не вспомнит. Здесь она в общей
   * очереди наравне с остальной работой.
   */
  /*
   * Зона считается один раз на весь маршрут.
   *
   * Первая редакция считала её дважды — здесь и ниже, для маршрутов, — и это
   * не «лишний запрос»: расчёт зоны обходит четыре таблицы, и на живой базе
   * очередь работы стала вдвое медленнее. Заметил не по коду, а по тому, что
   * смоук перестал укладываться в свои сроки и шесть сценариев отвалились по
   * времени.
   */
  const allowedPatients = await accessiblePatientIds(user);
  if (allowedPatients === null || allowedPatients.size) {
    const dispRows = await db
      .select({
        d: dispensary,
        firstName: users.firstName,
        lastName: users.lastName,
        middleName: users.middleName,
        anonymous: users.anonymous,
        pseudonym: users.pseudonym,
        unit: users.unit,
      })
      .from(dispensary)
      .innerJoin(users, eq(users.id, dispensary.patientId))
      .where(
        and(
          isNull(dispensary.removedAt),
          lt(dispensary.nextDueAt, new Date().toISOString()),
          allowedPatients ? inArray(dispensary.patientId, [...allowedPatients]) : undefined,
        ),
      )
      .limit(200);

    for (const r of dispRows) {
      const days = Math.floor((now - new Date(r.d.nextDueAt).getTime()) / 86_400_000);
      items.push({
        kind: "dispensary",
        id: r.d.patientId,
        userId: r.d.patientId,
        userName: fullNameOf(r as never),
        unit: r.unit,
        title: r.d.groupLabel,
        days,
        /*
         * Просроченным считается сразу: срок и есть срок. Мягкая граница
         * «плюс неделя» превратила бы правило в пожелание, а пожелание — в
         * привычку не смотреть.
         */
        overdue: true,
        assignedTo: null,
        since: r.d.nextDueAt,
        href: `/patients/${r.d.patientId}`,
      });
    }
  }

  // 5. Направления, по которым нет ответа
  const referralRows = await db
    .select({
      r: referrals,
      unit: users.unit,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(referrals)
    .innerJoin(users, eq(users.id, referrals.userId))
    .where(inArray(referrals.status, ["created", "accepted"]))
    .limit(200);

  for (const r of referralRows) {
    const days = Math.floor((now - new Date(r.r.createdAt).getTime()) / 86_400_000);
    items.push({
      kind: "referral",
      id: r.r.id,
      userId: r.r.userId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: r.r.status,
      // без обратной связи направление тихо теряется — семь дней уже повод
      destination: r.r.destination,
      days,
      overdue: days >= 7 || r.r.urgency === "immediate",
      assignedTo: null,
      since: r.r.createdAt,
      href: `/patients/${r.r.userId}/summary`,
    });
  }

  // 3. Назначения с истёкшим сроком
  const overdueAssignments = await db
    .select({
      a: batteryAssignments,
      batteryTitle: batteries.title,
      unit: users.unit,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(batteryAssignments)
    .innerJoin(batteries, eq(batteries.id, batteryAssignments.batteryId))
    .innerJoin(users, eq(users.id, batteryAssignments.userId))
    .where(
      and(
        isNull(batteryAssignments.completedAt),
        isNull(batteryAssignments.cancelledAt),
        /*
         * isNotNull, а не сравнение с null.
         *
         * Здесь стояло `due_at <> null`, а в SQL сравнение с null не даёт
         * истины никогда — ни для заполненного срока, ни для пустого. Всё
         * условие целиком не выполнялось ни разу, и вид работы «просроченное
         * назначение» не мог попасть в очередь вообще: вкладка стояла с нулём
         * при любом числе просроченных назначений в базе.
         *
         * Заметить это по экрану было нельзя — ноль выглядит как «ничего не
         * просрочено», а не как «не ищем». Нашлось при наполнении: назначений
         * завелось двадцать шесть, в очереди осталось ноль.
         */
        isNotNull(batteryAssignments.dueAt),
        lt(batteryAssignments.dueAt, new Date().toISOString()),
      ),
    )
    .limit(200);

  for (const r of overdueAssignments) {
    const days = Math.floor((now - new Date(r.a.dueAt!).getTime()) / 86_400_000);
    items.push({
      kind: "assignment",
      id: r.a.id,
      userId: r.a.userId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: r.batteryTitle,
      days,
      overdue: true,
      assignedTo: null,
      since: r.a.dueAt!,
      href: `/patients/${r.a.userId}/summary`,
    });
  }

  /*
   * 4. Просроченные повторы по протоколу наблюдения.
   *
   * Каскад открывает доступ к методике с отложенным сроком и пометкой
   * «Протокол наблюдения». Если срок вышел, а повтора нет — человек выпал
   * из наблюдения, и узнать об этом должен специалист, а не никто.
   */
  const overdueFollowups = await db
    .select({
      userId: surveyAccess.userId,
      surveyId: surveyAccess.surveyId,
      note: surveyAccess.note,
      expiresAt: surveyAccess.expiresAt,
      surveyTitle: surveys.title,
      unit: users.unit,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(surveyAccess)
    .innerJoin(surveys, eq(surveys.id, surveyAccess.surveyId))
    .innerJoin(users, eq(users.id, surveyAccess.userId))
    .where(
      and(
        isNotNull(surveyAccess.expiresAt),
        lt(surveyAccess.expiresAt, new Date().toISOString()),
        sql`${surveyAccess.note} like ${`${FOLLOWUP_NOTE}%`}`,
        // повтора так и не было: последнее прохождение раньше выдачи доступа
        sql`not exists (
          select 1 from responses r
          where r.user_id = ${surveyAccess.userId}
            and r.survey_id = ${surveyAccess.surveyId}
            and r.status = 'completed'
            and r.submitted_at > ${surveyAccess.grantedAt}
        )`,
      ),
    )
    .limit(200);

  for (const r of overdueFollowups) {
    const days = Math.floor((now - new Date(r.expiresAt!).getTime()) / 86_400_000);
    items.push({
      kind: "followup",
      id: `${r.userId}:${r.surveyId}`,
      userId: r.userId,
      userName: fullNameOf(r as never),
      unit: r.unit,
      title: t(r.surveyTitle as never, lang),
      days,
      overdue: true,
      assignedTo: null,
      since: r.expiresAt!,
      href: `/patients/${r.userId}/summary`,
    });
  }



  /*
   * В кризисном режиме порядок другой: сначала тяжесть, потом всё остальное.
   *
   * В обычный день очередь ведёт по видам работы — случай, шаг маршрута,
   * цель, — и это правильно: так работа не теряется. В массовое поступление
   * то же правило прячет тяжёлого за плановой рутиной.
   *
   * Меняется только порядок. Состав очереди и всё остальное — те же: режим,
   * который заодно что-то скрывает, опаснее любого потока пациентов.
   */
  items.sort(
    (a, b) =>
      Number(b.overdue) - Number(a.overdue) ||
      KIND_WEIGHT[a.kind] - KIND_WEIGHT[b.kind] ||
      a.since.localeCompare(b.since),
  );

  const mine = items.filter((i) => i.assignedTo === user.id).length;
  await audit(c, { action: "worklist.read", details: { total: items.length, mine } });

  return c.json({
    items: items.slice(0, 100),
    total: items.length,
    truncated: items.length > 100,
    /*
     * Счётчики по всем видам сразу, а не по трём выбранным вручную.
     *
     * Перечисленные поимённо, они отстали от списка видов: экран рисовал
     * вкладки «Просроченные повторы · 0 · Направления · 0 · Назначения · 0»
     * над строкой с непрочитанным письмом. Сумма вкладок не сходилась с
     * «Всё · 1», а до самой строки нельзя было отфильтроваться вовсе.
     *
     * Обход ключей KIND_WEIGHT привязывает счётчики к тому же списку, из
     * которого берётся порядок: новый вид работы приезжает со своей вкладкой
     * сам, и забыть его негде.
     */
    byKind: Object.fromEntries(
      (Object.keys(KIND_WEIGHT) as Kind[]).map((kind) => [kind, items.filter((i) => i.kind === kind).length]),
    ) as Record<Kind, number>,
    mine,
  });
});
