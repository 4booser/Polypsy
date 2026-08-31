import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { t } from "@quizzy/shared";
import type { Severity } from "@quizzy/shared";
import { db } from "../db";
import {
  batteryAssignments,
  conclusions,
  referrals,
  responses,
  riskAlerts,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { langOf, notFound } from "../lib/http";
import { accessiblePatientIds, surveyScopeFilter, surveyScopeFilterFor } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const timelineRoutes = new Hono<AppEnv>();
timelineRoutes.use("*", requireAuth, requireStaff);

/**
 * Хронология пациента: всё, что с ним происходило, на одной оси.
 *
 * Раньше, чтобы восстановить историю, приходилось обойти четыре экрана —
 * прохождения, тревоги, направления и заключения — и сложить порядок в
 * голове. Между тем именно порядок и есть клинический смысл: сработала
 * тревога до направления или после, был ли повторный замер после начала
 * терапии.
 *
 * Возвращаются факты, а не готовые строки: подписи собирает клиент, у
 * которого есть язык интерфейса.
 */

export type TimelineKind = "response" | "alert" | "referral" | "conclusion" | "assignment";

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  at: string;
  title: string;
  detail?: string | null;
  severity?: Severity | null;
  /** Куда вести по нажатию — уже готовый путь консоли */
  href?: string | null;
}

timelineRoutes.get("/:userId", async (c) => {
  const staff = c.get("user");
  const userId = c.req.param("userId");
  const lang = langOf(c);

  const patient = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!patient) notFound("err.patientNotFound");

  /*
   * Зона ответственности проверяется до всего остального: сотрудник видит
   * события только по своим методикам, и «пациента нет» — честный ответ,
   * потому что вне зоны его действительно нет.
   */
  /*
   * Пациент должен быть в зоне ответственности сотрудника. Раньше здесь
   * стояла только проверка «есть ли у сотрудника хоть одна методика», и
   * админ чужой группы получал 200 с пустой сводкой на любой существующий
   * идентификатор — то есть маршрут отвечал на вопрос «есть ли такой
   * пациент», который задавать ему никто не разрешал.
   */
  const allowed = await accessiblePatientIds(staff);
  if (allowed && !allowed.has(userId)) notFound("err.patientNotFound");

  const scope = await surveyScopeFilterFor(staff, userId);
  const scoped = await db.select({ id: surveys.id, title: surveys.title }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) notFound("err.patientNotFound");
  const titleOf = new Map(scoped.map((s) => [s.id, t(s.title as never, lang)]));

  const items: TimelineItem[] = [];

  const own = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, userId),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyIds),
      ),
    )
    .orderBy(desc(responses.submittedAt))
    .limit(200);

  for (const r of own) {
    items.push({
      id: `response:${r.id}`,
      kind: "response",
      at: r.submittedAt ?? r.startedAt,
      title: titleOf.get(r.surveyId) ?? "",
      detail: null,
      href: `/surveys/${r.surveyId}`,
    });
  }

  const alerts = await db
    .select()
    .from(riskAlerts)
    .where(and(eq(riskAlerts.userId, userId), inArray(riskAlerts.surveyId, surveyIds)))
    .orderBy(desc(riskAlerts.at))
    .limit(200);

  for (const a of alerts) {
    items.push({
      id: `alert:${a.id}`,
      kind: "alert",
      at: a.at,
      title: a.label,
      severity: (a.severity as Severity) ?? null,
      detail: titleOf.get(a.surveyId) ?? null,
      href: "/alerts",
    });
  }

  const refs = await db
    .select()
    .from(referrals)
    .where(eq(referrals.userId, userId))
    .orderBy(desc(referrals.createdAt))
    .limit(100);

  for (const r of refs) {
    items.push({
      id: `referral:${r.id}`,
      kind: "referral",
      at: r.createdAt,
      title: r.destination,
      detail: r.status,
      href: "/referrals",
    });
  }

  const responseIds = own.map((r) => r.id);
  const notes = responseIds.length
    ? await db
        .select()
        .from(conclusions)
        .where(inArray(conclusions.responseId, responseIds))
        .orderBy(desc(conclusions.createdAt))
        .limit(100)
    : [];

  for (const n of notes) {
    // в хронологию попадает факт и первая строка, а не весь текст:
    // заключение читают на карте, здесь оно — событие
    const text = decryptField(n.text) ?? "";
    items.push({
      id: `conclusion:${n.id}`,
      kind: "conclusion",
      at: n.signedAt ?? n.createdAt,
      title: text.slice(0, 90) + (text.length > 90 ? "…" : ""),
      detail: n.status,
      href: `/patients/${userId}/summary`,
    });
  }

  const assigned = await db
    .select()
    .from(batteryAssignments)
    .where(eq(batteryAssignments.userId, userId))
    .orderBy(desc(batteryAssignments.assignedAt))
    .limit(100);

  for (const a of assigned) {
    items.push({
      id: `assignment:${a.id}`,
      kind: "assignment",
      at: a.assignedAt,
      title: a.batteryId,
      detail: a.completedAt ? "completed" : a.cancelledAt ? "cancelled" : "open",
      href: "/batteries",
    });
  }

  items.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));

  await audit(c, {
    action: "response.read",
    resourceType: "user",
    resourceId: userId,
    subjectUserId: userId,
    details: { view: "timeline", events: items.length },
  });

  return c.json({ items });
});
