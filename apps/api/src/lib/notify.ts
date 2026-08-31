import nodemailer, { type Transporter } from "nodemailer";
import { and, eq, isNull, sql } from "drizzle-orm";
import { t } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import {
  alertNotifications,
  groupAdmins,
  riskAlerts,
  surveys,
  users,
} from "../db/schema";
import { env } from "../env";
import { auditSystem } from "./audit";
import { parseTs } from "./time";
import { log } from "./log";
import { pushToUsers } from "./push";
import { remindAppointments } from "./remind";

/**
 * Уведомления о тревогах риска.
 *
 * Тревога, которую видно только в открытой консоли, — клинически бессмысленна:
 * критический ответ должен догнать специалиста сам. Тик (по образцу
 * планировщика) рассылает письма по свежим тревогам и эскалирует не
 * подтверждённые в срок. Идемпотентность — уникальность (alert, kind).
 *
 * В письме НЕТ персональных данных: только методика, уровень и ссылка в
 * консоль. Почтовый сервер — не хранилище медицинских данных.
 */

let transporter: Transporter | null | undefined;

function getTransport(): Transporter | null {
  if (transporter !== undefined) return transporter;
  transporter = env.smtpUrl ? nodemailer.createTransport(env.smtpUrl) : null;
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

async function superadminEmails(): Promise<string[]> {
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

const SEVERITY_LABEL: Record<string, string> = {
  severe: "критический",
  moderate: "повышенный",
};

/**
 * Один проход: первичные уведомления по тревогам без отметки, затем
 * эскалации по не подтверждённым дольше порога методики.
 */
export async function runNotifierOnce(now = new Date()): Promise<{ initial: number; escalated: number }> {
  return systemContext(baseDb, () => runNotifierInner(now));
}

async function runNotifierInner(now: Date): Promise<{ initial: number; escalated: number }> {
  let initial = 0;
  let escalated = 0;

  /* ── первичные ── */
  const fresh = await db
    .select({ alert: riskAlerts, survey: surveys })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .where(
      sql`not exists (select 1 from alert_notifications an
        where an.alert_id = ${riskAlerts.id} and an.kind = 'initial')`,
    )
    .limit(50);

  for (const { alert, survey } of fresh) {
    try {
      const to = await recipientsFor(survey.id);
      const title = t(survey.title as never, "ru");
      const channel = await send({
        to,
        subject: `Тревога: ${SEVERITY_LABEL[alert.severity] ?? alert.severity} ответ — ${title}`,
        text: [
          `В методике «${title}» получен ${SEVERITY_LABEL[alert.severity] ?? alert.severity} ответ.`,
          "",
          `Откройте консоль, чтобы увидеть, кто и на какой пункт ответил:`,
          `${env.consoleUrl}/alerts`,
          "",
          "Персональные данные в письме не передаются намеренно.",
        ].join("\n"),
      });
      await db
        .insert(alertNotifications)
        .values({
          id: crypto.randomUUID(),
          alertId: alert.id,
          kind: "initial",
          recipients: to.join(","),
          channel,
        })
        .onConflictDoNothing();
      /*
       * Пуш идёт тем же адресатам и в том же такте, что письмо: почту
       * открывают не всегда, а тревога о суицидальном риске должна догнать
       * дежурного там, где он есть.
       */
      await pushToUsers(await pushRecipientsFor(survey.id), {
        eventKey: `alert:${alert.id}`,
        kind: "alert",
        title: "Тревога в вашей группе",
        body: `Методика «${title}». Откройте разбор случаев.`,
        path: "/analytics/alerts",
      });

      await auditSystem({
        action: "alert.notified",
        resourceType: "risk_alert",
        resourceId: alert.id,
        subjectUserId: alert.userId,
        details: { surveyId: survey.id, channel, recipients: to.length },
      });
      initial++;
    } catch (error) {
      log.error("alert.notify_failed", { alertId: alert.id, error: String(error) });
    }
  }

  /* ── эскалации ── */
  const escalatable = await db
    .select({ alert: riskAlerts, survey: surveys })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .where(
      and(
        isNull(riskAlerts.acknowledgedAt),
        sql`${surveys.alertEscalateMinutes} is not null`,
        sql`not exists (select 1 from alert_notifications an
          where an.alert_id = ${riskAlerts.id} and an.kind = 'escalation')`,
      ),
    )
    .limit(50);

  for (const { alert, survey } of escalatable) {
    if (parseTs(alert.at) + (survey.alertEscalateMinutes ?? 0) * 60_000 > now.getTime()) continue;
    try {
      const to = await superadminEmails();
      const title = t(survey.title as never, "ru");
      const minutes = Math.round((now.getTime() - parseTs(alert.at)) / 60_000);
      const channel = await send({
        to,
        subject: `ЭСКАЛАЦИЯ: тревога не разобрана ${minutes} мин — ${title}`,
        text: [
          `Тревога по методике «${title}» не подтверждена за ${survey.alertEscalateMinutes} мин.`,
          `Открыта уже ${minutes} мин.`,
          "",
          `${env.consoleUrl}/alerts`,
        ].join("\n"),
      });
      await db
        .insert(alertNotifications)
        .values({
          id: crypto.randomUUID(),
          alertId: alert.id,
          kind: "escalation",
          recipients: to.join(","),
          channel,
        })
        .onConflictDoNothing();
      await auditSystem({
        action: "alert.escalated",
        resourceType: "risk_alert",
        resourceId: alert.id,
        subjectUserId: alert.userId,
        details: { surveyId: survey.id, minutesOpen: minutes, channel, recipients: to.length },
      });
      escalated++;
    } catch (error) {
      log.error("alert.escalate_failed", { alertId: alert.id, error: String(error) });
    }
  }

  return { initial, escalated };
}

/** Минутный тик: тревога должна догонять специалиста быстро */
export function startNotifier(intervalMs = 60_000): () => void {
  const tick = () => {
    runNotifierOnce().catch((error) => log.error("notifier.tick_failed", { error: String(error) }));
    /*
     * Напоминания о приёме — тем же тактом. Отдельного таймера не заводим:
     * повторов рассылка не боится (отсекает по ключу события), а минутный шаг
     * означает, что «за час» приходит с точностью до минуты.
     */
    void systemContext(baseDb, () => remindAppointments()).catch((error) =>
      log.warn("clinic.remind_failed", { error: String(error) }),
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
