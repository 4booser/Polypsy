import { hostname } from "node:os";
import nodemailer, { type Transporter } from "nodemailer";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { renderPush, serverText, t, type Lang } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import {
  alertDeliveries,
  alertNotifications,
  groupAdmins,
  pushDeliveries,
  riskAlerts,
  surveys,
  users,
} from "../db/schema";
import { env } from "../env";
import { auditSystem } from "./audit";
import { parseTs } from "./time";
import { log } from "./log";
import { registerJob, skipJob, trackJob } from "./opsJobs";
import { pushToUser } from "./push";
import { syncDueMeetings } from "./meetSync";
import { remindAppointments } from "./remind";
import { pushMailings } from "./mailingPush";

/**
 * Уведомления о тревогах риска.
 *
 * Тревога, которую видно только в открытой консоли, — клинически бессмысленна:
 * критический ответ должен догнать специалиста сам. Тик (по образцу
 * планировщика) рассылает письма по свежим тревогам и эскалирует не
 * подтверждённые в срок. Отметка «дошло» — уникальность (alert, kind) в
 * alert_notifications; всё, что до неё, — захват, попытки, «не дошло» —
 * в alert_deliveries (см. «доставка» ниже).
 *
 * В письме НЕТ персональных данных: только методика, уровень и ссылка в
 * консоль. Почтовый сервер — не хранилище медицинских данных.
 */

let transporter: Transporter | null | undefined;

/** Таймауты SMTP-транспорта, мс; см. smtpTransport */
export const SMTP_TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 } as const;

/**
 * SMTP-транспорт по адресу из SMTP_URL — с таймаутами.
 *
 * Таймауты обязательны, и вот почему.
 *
 * У nodemailer сокетный таймаут по умолчанию — десять минут, а отправка
 * идёт внутри транзакции запроса и держит соединение из пула. Тик
 * минутный и предыдущего не ждёт. Зависший (не отказавший, а именно
 * зависший — обычный случай) почтовый сервер учреждения за десять минут
 * набирает десять одновременных проходов, пул из десяти соединений
 * кончается, и API перестаёт обслуживать запросы. Отказ почты
 * превращался в отказ консоли и мобильного приложения целиком, включая
 * экран приёма.
 *
 * Адрес и таймауты — одним объектом { url, … }. Прежде таймауты шли вторым
 * аргументом createTransport(url, …), а второй аргумент у nodemailer — это
 * умолчания ПИСЬМА, не настройки соединения: транспорт их молча отбрасывал,
 * и десятиминутный таймаут стоял как есть. Собственные типы nodemailer 10
 * это поймали (у @types/nodemailer 8 второй аргумент был шире); объектная
 * форма с url поддерживается с 10.0.0. Сторож — test/smtpTransport.test.ts.
 */
export function smtpTransport(url: string): Transporter {
  return nodemailer.createTransport({ url, ...SMTP_TIMEOUTS });
}

function getTransport(): Transporter | null {
  if (transporter !== undefined) return transporter;
  transporter = env.smtpUrl ? smtpTransport(env.smtpUrl) : null;
  return transporter;
}

/** Подмена транспорта в тестах */
export function setTransportForTests(value: Transporter | null): void {
  transporter = value;
}

/** Админы группы методики; без группы или без админов — все суперадмины */
async function recipientsFor(surveyId: string): Promise<string[]> {
  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, surveyId) });
  if (survey?.groupId) {
    const rows = await db
      .select({ email: users.email })
      .from(groupAdmins)
      .innerJoin(users, eq(users.id, groupAdmins.userId))
      .where(eq(groupAdmins.groupId, survey.groupId));
    if (rows.length) return rows.map((r) => r.email);
  }
  const supers = await db.select({ email: users.email }).from(users).where(eq(users.role, "superadmin"));
  return supers.map((r) => r.email);
}

/**
 * Кому уходит пуш о тревоге.
 *
 * Тот же круг, что и у письма, но идентификаторами: пуш адресуется учётной
 * записи, а не почте. Разъехаться эти два списка не должны — дежурный,
 * получающий письмо, но не получающий пуш, узнаёт о тревоге позже всех.
 */
async function pushRecipientsFor(surveyId: string): Promise<string[]> {
  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, surveyId) });
  if (survey?.groupId) {
    const rows = await db
      .select({ id: groupAdmins.userId })
      .from(groupAdmins)
      .where(eq(groupAdmins.groupId, survey.groupId));
    if (rows.length) return rows.map((r) => r.id);
  }
  const supers = await db.select({ id: users.id }).from(users).where(eq(users.role, "superadmin"));
  return supers.map((r) => r.id);
}

export async function superadminEmails(): Promise<string[]> {
  const rows = await db.select({ email: users.email }).from(users).where(eq(users.role, "superadmin"));
  return rows.map((r) => r.email);
}

interface AlertMail {
  to: string[];
  subject: string;
  text: string;
}

async function send(mail: AlertMail): Promise<"email" | "none"> {
  const transport = getTransport();
  if (!transport || !mail.to.length) return "none";
  await transport.sendMail({
    from: env.mailFrom,
    to: mail.to.join(", "),
    subject: mail.subject,
    text: mail.text,
  });
  return "email";
}

/**
 * Письмо техпанели — оповещение о работе системы (lib/opsAlerts.ts).
 *
 * Тем же транспортом и с теми же таймаутами, что тревоги: второй
 * транспорт рядом был бы вторым местом, где однажды забудут таймаут, и
 * зависший почтовый сервер снова съел бы пул. «none» — SMTP не настроен или
 * слать некому.
 */
export function sendSystemMail(to: string[], subject: string, text: string): Promise<"email" | "none"> {
  return send({ to, subject, text });
}

/** Есть ли чем слать почту — только «да / нет», адрес сервера наружу не уходит */
export function mailTransportReady(): boolean {
  return getTransport() !== null;
}

/*
 * Язык того, что сервер шлёт сотрудникам без их запроса: письма тревог
 * (ниже) и событие в календаре специалиста (routes/clinic.ts).
 *
 * Языка получателя сервер не знает: у учётной записи его нет, а письмо
 * тревоги одно на всех дежурных. Прежде оно уходило по-русски — набранное
 * прямо здесь. Теперь — из словаря (serverStrings.ts, mail.*), на языке
 * отделения, как оповещения техпанели (lib/opsAlerts.ts): учреждение
 * украинское, и язык у отделения один. Будет у сотрудника свой язык — он
 * встанет сюда параметром, а тексты уже переведены на все три.
 */
export const STAFF_OUTBOUND_LANG: Lang = "uk";

/** Уровень тревоги словом, согласованным с «відповідь» / «ответ» (mail.alert.*) */
function severityWord(severity: string, lang: Lang): string {
  if (severity === "severe") return serverText("mail.sev.severe", lang);
  if (severity === "moderate") return serverText("mail.sev.moderate", lang);
  return severity;
}

/*
 * ─── доставка: захват, отправка, итог ───
 *
 * Прежде проход шёл одной транзакцией: выбрать тревоги без отметки,
 * отправить письмо, записать отметку, закоммитить всё в конце. У этого три
 * следствия, и все три — про клиническую тревогу, которая должна дойти.
 *
 * Отметка «разослано» писалась при любом исходе, в том числе «none» —
 * почта не настроена или слать некому. Если и пуш не ушёл (у дежурного нет
 * устройства), о тревоге не узнавал никто, а она числилась разосланной, и
 * после того как почту починили, первичное уведомление уже не повторялось.
 *
 * Два процесса API (выкатка идёт с перекрытием) видели одну и ту же тревогу
 * без отметки — отметка первого ещё не закоммичена — и отправляли оба.
 *
 * Письмо уходило раньше, чем фиксировалась отметка. Любой сбой после
 * отправки (одна ошибка в проходе обрывает всю транзакцию PostgreSQL)
 * откатывал отметки ВСЕХ тревог прохода, и следующий тик слал их письма
 * заново — и так каждую минуту, пока сбой повторяется.
 *
 * Теперь у каждого уведомления своя строка в alert_deliveries и три
 * коротких шага, каждый своей транзакцией:
 *   захват — строка переходит в «отправляется» с владельцем (этот проход) и
 *     сроком; взять можно только свободное, недоставленное или просроченное,
 *     поэтому второй процесс то же письмо не шлёт;
 *   отправка — вне транзакции, соединение из пула не держится на сетевом
 *     вызове; счётчик писем растёт ДО отправки;
 *   итог — «дошло» (и строка в alert_notifications), только если письмо
 *     принял почтовый сервер или пуш ушёл хотя бы одному дежурному; иначе
 *     «не дошло», и следующий проход попробует снова.
 *
 * ─── «хотя бы один раз» или «не больше одного» ───
 *
 * Для клинической тревоги — хотя бы один раз, с потолком. Пропущенное
 * уведомление дороже лишнего: дежурный, не узнавший о суицидальном риске, —
 * это и есть отказ, ради которого рассыльщик существует, а второе письмо о
 * той же тревоге — неудобство. Поэтому процесс, упавший между «сервер
 * принял» и «записали», не хоронит уведомление: захват истекает, и письмо
 * уходит ещё раз.
 *
 * Но письмо, приходящее снова и снова, приучает тревоги не читать (см.
 * lib/push.ts), и потолок нужен. Счётчик mails растёт до отправки и
 * откатывается, только если сервер явно отказал, — значит, он считает
 * письма, которые ушли ИЛИ МОГЛИ уйти. На третьем таком письме без
 * подтверждения рассыльщик останавливается: строка «брошено», запись в
 * журнале действий и ошибка в логе (её видит техпанель). Тревога при этом
 * остаётся в очереди консоли, а эскалация — отдельное уведомление со своим
 * счётчиком.
 *
 * Недоставленное (ничего не ушло) повторяется без потолка, но только пока
 * тревогу не подтвердили: письмо «откройте консоль» по разобранной тревоге
 * — шум. В журнале она так и остаётся недоставленной — это правда.
 */

/** Срок захвата: письмо и пуши одной тревоги укладываются с большим запасом */
const LEASE_MS = 10 * 60_000;
/** Столько писем об одном уведомлении может уйти без подтверждения, что дошло */
const MAX_MAILS = 3;
/** Процесс рассыльщика — первая половина владельца захвата */
const PROCESS_TAG = `${hostname()}:${process.pid}`;

type NotifyKind = "initial" | "escalation";
type AlertRow = typeof riskAlerts.$inferSelect;
type SurveyRow = typeof surveys.$inferSelect;

interface DeliveryJob {
  alertId: string;
  kind: NotifyKind;
  /** Проход, взявший задание: свой захват отличается от чужого */
  owner: string;
}

/**
 * Тревоги, по которым уведомление этого вида ещё не дошло и его можно брать.
 *
 * Сначала те, по которым не пробовали ни разу, потом — давнее пробованные:
 * иначе полсотни тревог, недоставленных из-за сломанной почты, занимали бы
 * каждый проход целиком, и свежая тревога ждала бы за ними.
 */
async function deliveryCandidates(kind: NotifyKind, now: Date) {
  const d = alertDeliveries;
  return db
    .select({ alert: riskAlerts, survey: surveys })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .leftJoin(d, and(eq(d.alertId, riskAlerts.id), eq(d.kind, kind)))
    .where(
      and(
        sql`not exists (select 1 from alert_notifications an
          where an.alert_id = ${riskAlerts.id} and an.kind = ${kind})`,
        or(
          isNull(d.alertId),
          and(
            isNull(riskAlerts.acknowledgedAt),
            or(eq(d.state, "undelivered"), and(eq(d.state, "sending"), sql`${d.leaseUntil} < now()`)),
          ),
        ),
        ...(kind === "escalation"
          ? [
              isNull(riskAlerts.acknowledgedAt),
              sql`${surveys.alertEscalateMinutes} is not null`,
              /*
               * Срок — в запросе, а не фильтром после него: полсотни ещё не
               * созревших тревог иначе занимали бы весь лимит, и созревшая
               * пятьдесят первая не эскалировалась бы никогда.
               */
              sql`${riskAlerts.at} + make_interval(mins => ${surveys.alertEscalateMinutes}) <= ${now.toISOString()}`,
            ]
          : []),
      ),
    )
    .orderBy(sql`${d.lastAt} asc nulls first`, riskAlerts.at)
    .limit(50);
}

/**
 * Взять задание. Одним оператором: строки ещё нет — вставить её уже
 * захваченной; есть — захватить, только если она недоставлена или захват
 * просрочен. Второй процесс, пришедший к той же тревоге, упирается в строку
 * первого и не получает ничего. Уже дошедшее (строка в alert_notifications,
 * в том числе отмеченное до этой миграции) не берётся вовсе.
 */
async function claimDelivery(job: DeliveryJob): Promise<{ attempts: number; mails: number } | null> {
  const [row] = await db.execute<{ attempts: number; mails: number }>(sql`
    insert into alert_deliveries (alert_id, kind, state, owner, lease_until, attempts, first_at, last_at)
    select ${job.alertId}, ${job.kind}, 'sending', ${job.owner},
           now() + make_interval(secs => ${LEASE_MS / 1000}), 1, now(), now()
     where not exists (select 1 from alert_notifications an
                        where an.alert_id = ${job.alertId} and an.kind = ${job.kind})
    on conflict (alert_id, kind) do update
       set state = 'sending',
           owner = excluded.owner,
           lease_until = excluded.lease_until,
           attempts = alert_deliveries.attempts + 1,
           last_at = now()
     where alert_deliveries.state = 'undelivered'
        or (alert_deliveries.state = 'sending' and alert_deliveries.lease_until < now())
    returning attempts, mails
  `);
  return row ? { attempts: Number(row.attempts), mails: Number(row.mails) } : null;
}

/** Письмо вот-вот уйдёт: счётчик растёт ДО отправки — см. обоснование выше */
async function countMail(job: DeliveryJob): Promise<void> {
  await db
    .update(alertDeliveries)
    .set({ mails: sql`${alertDeliveries.mails} + 1` })
    .where(
      and(
        eq(alertDeliveries.alertId, job.alertId),
        eq(alertDeliveries.kind, job.kind),
        eq(alertDeliveries.owner, job.owner),
      ),
    );
}

/** Скольким из дежурных пуш об этой тревоге ушёл — в этом проходе или раньше */
async function pushedCount(alertId: string, userIds: string[]): Promise<number> {
  if (!userIds.length) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(pushDeliveries)
    .where(
      and(
        eq(pushDeliveries.eventKey, `alert:${alertId}`),
        inArray(pushDeliveries.userId, userIds),
        // ok = false — постоянный отказ провайдера (lib/push.ts): заявка есть, доставки нет
        eq(pushDeliveries.ok, true),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Код отказа почты — без текста исключения: в нём бывают адреса */
function mailFailure(error: unknown): string {
  const text = String(error);
  const smtp = /\b([45]\d\d)\b/.exec(text);
  if (smtp) return `smtp_${smtp[1]}`;
  if (/timeout|timed out/i.test(text)) return "timeout";
  return "network";
}

function alertMail(kind: NotifyKind, alert: AlertRow, survey: SurveyRow, to: string[], now: Date): AlertMail {
  const lang = STAFF_OUTBOUND_LANG;
  // название — на том же языке, что и письмо (прежде — русское при любом)
  const title = t(survey.title as never, lang);
  const level = severityWord(alert.severity, lang);
  if (kind === "initial") {
    return {
      to,
      subject: serverText("mail.alert.subject", lang, { level, title }),
      text: [
        serverText("mail.alert.body", lang, { level, title }),
        "",
        serverText("mail.alert.open", lang),
        `${env.consoleUrl}/alerts`,
        "",
        serverText("mail.alert.noPersonal", lang),
      ].join("\n"),
    };
  }
  const minutes = Math.round((now.getTime() - parseTs(alert.at)) / 60_000);
  return {
    to,
    subject: serverText("mail.escalation.subject", lang, { minutes, title }),
    text: [
      serverText("mail.escalation.body", lang, { title, limit: survey.alertEscalateMinutes ?? "—" }),
      serverText("mail.escalation.open", lang, { minutes }),
      "",
      `${env.consoleUrl}/alerts`,
    ].join("\n"),
  };
}

interface DeliveryOutcome {
  to: string[];
  email: "sent" | "none" | "failed";
  pushed: number;
  error: string | null;
}

/** Итог попытки: «дошло» — если письмо принято или пуш ушёл; иначе «не дошло» */
async function recordDelivery(
  job: DeliveryJob,
  alert: AlertRow,
  survey: SurveyRow,
  outcome: DeliveryOutcome,
  now: Date,
): Promise<boolean> {
  const at = new Date().toISOString();
  const where = and(eq(alertDeliveries.alertId, job.alertId), eq(alertDeliveries.kind, job.kind));
  const delivered = outcome.email === "sent" || outcome.pushed > 0;

  if (delivered) {
    /*
     * Без условия на владельца: дошло — значит дошло, даже если за это
     * время наш захват успел истечь и задание взял другой проход. Его
     * отметка тогда ляжет второй и ничего не изменит.
     */
    await db
      .update(alertDeliveries)
      .set({
        state: "delivered",
        owner: null,
        leaseUntil: null,
        email: outcome.email,
        pushed: outcome.pushed,
        error: outcome.error,
        lastAt: at,
        deliveredAt: at,
      })
      .where(where);
    const channel = outcome.email === "sent" ? "email" : "push";
    await db
      .insert(alertNotifications)
      .values({ id: crypto.randomUUID(), alertId: alert.id, kind: job.kind, recipients: outcome.to.join(","), channel })
      .onConflictDoNothing();
    await auditSystem({
      action: job.kind === "initial" ? "alert.notified" : "alert.escalated",
      resourceType: "risk_alert",
      resourceId: alert.id,
      subjectUserId: alert.userId,
      details: {
        surveyId: survey.id,
        channel,
        recipients: outcome.to.length,
        pushed: outcome.pushed,
        ...(job.kind === "escalation" ? { minutesOpen: Math.round((now.getTime() - parseTs(alert.at)) / 60_000) } : {}),
      },
    });
    return true;
  }

  const [row] = await db
    .update(alertDeliveries)
    .set({
      state: "undelivered",
      owner: null,
      leaseUntil: null,
      email: outcome.email,
      pushed: outcome.pushed,
      error: outcome.error,
      lastAt: at,
      // сервер явно отказал — письмо не ушло, в потолок оно не считается
      ...(outcome.email === "failed" ? { mails: sql`greatest(${alertDeliveries.mails} - 1, 0)` } : {}),
    })
    .where(and(where, eq(alertDeliveries.owner, job.owner), eq(alertDeliveries.state, "sending")))
    .returning({ attempts: alertDeliveries.attempts });
  /*
   * В журнал действий — первый раз, а не каждую минуту: повторы пишут
   * attempts и last_at в своей строке, а журнал отвечает на вопрос «была ли
   * тревога, о которой не узнал никто».
   */
  if (row?.attempts === 1) {
    log.warn("alert.undelivered", { alertId: alert.id, kind: job.kind, email: outcome.email, error: outcome.error });
    await auditSystem({
      action: "alert.undelivered",
      resourceType: "risk_alert",
      resourceId: alert.id,
      subjectUserId: alert.userId,
      outcome: "error",
      details: { surveyId: survey.id, kind: job.kind, email: outcome.email, recipients: outcome.to.length },
    });
  }
  return false;
}

/**
 * Одно уведомление целиком: захват, адресаты, письмо, пуш, итог. Истина —
 * дошло в этом проходе.
 */
async function deliverAlert(
  job: DeliveryJob,
  alert: AlertRow,
  survey: SurveyRow,
  now: Date,
): Promise<boolean> {
  const claimed = await systemContext(baseDb, () => claimDelivery(job));
  // взял другой проход, или уже дошло
  if (!claimed) return false;

  if (claimed.mails >= MAX_MAILS) {
    await systemContext(baseDb, async () => {
      await db
        .update(alertDeliveries)
        .set({ state: "abandoned", owner: null, leaseUntil: null, lastAt: new Date().toISOString() })
        .where(
          and(
            eq(alertDeliveries.alertId, job.alertId),
            eq(alertDeliveries.kind, job.kind),
            eq(alertDeliveries.owner, job.owner),
          ),
        );
      await auditSystem({
        action: "alert.notify_abandoned",
        resourceType: "risk_alert",
        resourceId: alert.id,
        subjectUserId: alert.userId,
        outcome: "error",
        details: { surveyId: survey.id, kind: job.kind, mails: claimed.mails },
      });
    });
    log.error("alert.notify_abandoned", { alertId: alert.id, kind: job.kind, mails: claimed.mails });
    return false;
  }

  /*
   * Эскалация — суперадминам и только письмом: она о том, что дежурные
   * группы тревогу не разобрали, и адресована тем, кто над ними.
   */
  const { to, pushTo } = await systemContext(baseDb, async () => ({
    to: job.kind === "initial" ? await recipientsFor(survey.id) : await superadminEmails(),
    pushTo: job.kind === "initial" ? await pushRecipientsFor(survey.id) : [],
  }));

  let email: DeliveryOutcome["email"] = "none";
  let error: string | null = null;
  if (getTransport() && to.length) {
    await systemContext(baseDb, () => countMail(job));
    try {
      await send(alertMail(job.kind, alert, survey, to, now));
      email = "sent";
    } catch (failure) {
      email = "failed";
      error = mailFailure(failure);
      log.warn("alert.mail_failed", { alertId: alert.id, kind: job.kind, error: String(failure) });
    }
  }

  /*
   * Пуш идёт тем же адресатам и в том же такте, что письмо: почту
   * открывают не всегда, а тревога о суицидальном риске должна догнать
   * дежурного там, где он есть.
   *
   * Текст — на языке устройства дежурного (pushToUser), название методики —
   * тоже: t() по тому же языку. Письмо выше остаётся русским — у почтового
   * адреса языка нет, и выбирать его не по чему.
   *
   * Каждому — своей короткой транзакцией, как в напоминаниях (remind.ts):
   * повтор pushToUser отсекает сам по push_deliveries, а сбой пуша одному
   * дежурному не должен уносить ни письмо, ни пуш остальным.
   */
  let pushed = 0;
  if (pushTo.length) {
    for (const userId of pushTo) {
      try {
        await systemContext(baseDb, () =>
          pushToUser(userId, {
            eventKey: `alert:${alert.id}`,
            kind: "alert",
            title: (lang) => renderPush("push.alertTitle", lang),
            body: (lang) => renderPush("push.alertBody", lang, { title: t(survey.title as never, lang) }),
            path: "/analytics/alerts",
          }),
        );
      } catch (failure) {
        log.warn("alert.push_failed", { alertId: alert.id, error: String(failure) });
      }
    }
    pushed = await systemContext(baseDb, () => pushedCount(alert.id, pushTo));
  }

  return systemContext(baseDb, () => recordDelivery(job, alert, survey, { to, email, pushed, error }, now));
}

/**
 * Один проход: первичные уведомления по тревогам, где они ещё не дошли, затем
 * эскалации по не подтверждённым дольше порога методики.
 *
 * Без общей транзакции — каждый шаг берёт свою (см. «доставка» выше).
 */
export async function runNotifierOnce(now = new Date()): Promise<{ initial: number; escalated: number }> {
  const owner = `${PROCESS_TAG}:${crypto.randomUUID()}`;
  let initial = 0;
  let escalated = 0;

  const fresh = await systemContext(baseDb, () => deliveryCandidates("initial", now));
  for (const { alert, survey } of fresh) {
    try {
      if (await deliverAlert({ alertId: alert.id, kind: "initial", owner }, alert, survey, now)) initial++;
    } catch (error) {
      log.error("alert.notify_failed", { alertId: alert.id, error: String(error) });
    }
  }

  const due = await systemContext(baseDb, () => deliveryCandidates("escalation", now));
  for (const { alert, survey } of due) {
    try {
      if (await deliverAlert({ alertId: alert.id, kind: "escalation", owner }, alert, survey, now)) escalated++;
    } catch (error) {
      log.error("alert.escalate_failed", { alertId: alert.id, error: String(error) });
    }
  }

  return { initial, escalated };
}

/** Минутный тик: тревога должна догонять специалиста быстро */
export function startNotifier(intervalMs = 60_000): () => void {
  let running = false;
  /* такты — в реестр техпанели (opsJobs.ts), как у планировщика */
  registerJob("notifier", intervalMs);
  registerJob("clinic.remind", intervalMs);
  registerJob("mailings.push", intervalMs);
  registerJob("clinic.meet_sync", intervalMs);
  const tick = () => {
    /*
     * Такты не накладываются друг на друга.
     *
     * `setInterval` стрелял каждую минуту независимо от того, закончился ли
     * прошлый проход. При медленной почте это множит одновременные проходы,
     * каждый из которых держит соединение, — и они кончаются.
     */
    if (running) {
      log.warn("notifier.tick_skipped", { reason: "предыдущий проход ещё идёт" });
      skipJob("notifier");
      return;
    }
    running = true;
    trackJob("notifier", () => runNotifierOnce())
      .catch((error) => log.error("notifier.tick_failed", { error: String(error) }))
      .finally(() => {
        running = false;
      });
    /*
     * Напоминания о приёме — тем же тактом. Отдельного таймера не заводим:
     * повторов рассылка не боится (отсекает по ключу события), а минутный шаг
     * означает, что «за час» приходит с точностью до минуты.
     */
    // без обёртки контекстом: рассылка сама берёт снимок данных одной
    // транзакцией и отправляет вне её — общая обёртка держала бы соединение
    // из пула открытым на все сетевые вызовы разом
    void trackJob("clinic.remind", () => remindAppointments()).catch((error) =>
      log.warn("clinic.remind_failed", { error: String(error) }),
    );
    /*
     * Пуши о рассылках — тем же тактом и по тем же причинам: своего таймера
     * не заводим, повторов проход не боится (ключ события — рассылка и
     * человек), а сетевые вызовы идут вне транзакции запроса, который
     * рассылку отправил.
     */
    void trackJob("mailings.push", () => pushMailings()).catch((error) =>
      log.warn("mailings.push_failed", { error: String(error) }),
    );
    /*
     * События календаря, которые не удалось свести из запроса (Google не
     * ответил на переносе или отмене), — тем же тактом (lib/meetSync.ts, #37).
     */
    void trackJob("clinic.meet_sync", () => syncDueMeetings()).catch((error) =>
      log.warn("clinic.meet_sync_failed", { error: String(error) }),
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
