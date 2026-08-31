import { Hono } from "hono";
import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { t } from "@quizzy/shared";
import { db } from "../db";
import { alertCases, batteries, referrals, scheduleRuns, schedules, surveys, users } from "../db/schema";
import { fullNameOf } from "../lib/auth";
import { langOf, parseQuery } from "../lib/http";
import { accessibleGroupIds, accessiblePatientIds, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const missedRoutes = new Hono<AppEnv>();
/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 */
missedRoutes.use("*", requireAuth, requireStaff, requirePermission("patients.read"));

/**
 * «Что произошло, пока меня не было».
 *
 * Считается запросом по существующим таблицам, а не читается из отдельного
 * журнала событий. Второй журнал пришлось бы писать при каждом изменении, и
 * рано или поздно он разошёлся бы с тем, что есть на самом деле: случай
 * закрыли, а в ленте он открыт. Здесь источник один — сами данные.
 *
 * Цена решения честная: не всё имеет отметку времени, по которой можно
 * спросить «что изменилось с тех пор». Показывается то, что имеет: новые
 * случаи риска, разобранные другими, новые направления и сработавшие
 * расписания. Чего здесь нет — того и не обещано.
 */

const query = z.object({
  since: z.string(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

missedRoutes.get("/", async (c) => {
  const user = c.get("user");
  const { since, limit } = parseQuery(c, query);
  const lang = langOf(c);

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id, title: surveys.title }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json({ since, groups: [] });
  const titleOf = new Map(scoped.map((s) => [s.id, t(s.title as never, lang)]));

  const opened = await db
    .select({ row: alertCases, patient: users })
    .from(alertCases)
    .leftJoin(users, eq(users.id, alertCases.userId))
    .where(
      and(
        inArray(alertCases.surveyId, surveyIds),
        gt(alertCases.openedAt, since),
        // ещё не разобранные: разобранные попадут в свою группу ниже
        sql`${alertCases.acknowledgedAt} is null`,
      ),
    )
    .orderBy(desc(alertCases.openedAt))
    .limit(limit);

  /*
   * Разобранные — только чужими руками. Свои собственные действия человек
   * помнит, и показывать их в сводке «пока тебя не было» значит разбавлять её
   * тем, что он и так знает.
   */
  const resolved = await db
    .select({ row: alertCases, patient: users })
    .from(alertCases)
    .leftJoin(users, eq(users.id, alertCases.userId))
    .where(
      and(
        inArray(alertCases.surveyId, surveyIds),
        isNotNull(alertCases.acknowledgedAt),
        gt(alertCases.acknowledgedAt, since),
        ne(alertCases.acknowledgedBy, user.id),
      ),
    )
    .orderBy(desc(alertCases.acknowledgedAt))
    .limit(limit);

  /*
   * Направления привязаны к человеку, а не к методике: у них нет surveyId, и
   * подсовывать вместо него методику прохождения значило бы терять
   * направления, выписанные без прохождения.
   */
  const allowedPatients = await accessiblePatientIds(user);
  const newReferrals =
    allowedPatients && allowedPatients.size === 0
      ? []
      : await db
          .select({ row: referrals, patient: users })
          .from(referrals)
          .leftJoin(users, eq(users.id, referrals.userId))
          .where(
            and(
              gt(referrals.createdAt, since),
              allowedPatients ? inArray(referrals.userId, [...allowedPatients]) : undefined,
            ),
          )
          .orderBy(desc(referrals.createdAt))
          .limit(limit);

  /*
   * Расписание назначает батарею, а не методику: область видимости берётся у
   * группы батареи. Пустые прогоны не показываются — тик случается каждый
   * час, и «расписание отработало, никого не назначив» новостью не является.
   */
  const groupIds = await accessibleGroupIds(user);
  const runs =
    groupIds && groupIds.length === 0
      ? []
      : await db
          .select({ run: scheduleRuns, schedule: schedules })
          .from(scheduleRuns)
          .innerJoin(schedules, eq(schedules.id, scheduleRuns.scheduleId))
          .innerJoin(batteries, eq(batteries.id, schedules.batteryId))
          .where(
            and(
              gt(scheduleRuns.ranAt, since),
              sql`${scheduleRuns.assigned} > 0`,
              groupIds ? inArray(batteries.groupId, groupIds) : undefined,
            ),
          )
          .orderBy(desc(scheduleRuns.ranAt))
          .limit(limit);

  const groups = [
    {
      kind: "case.opened" as const,
      count: opened.length,
      items: opened.map((r) => ({
        id: r.row.id,
        at: r.row.openedAt,
        title: r.patient ? fullNameOf(r.patient) : "—",
        detail: titleOf.get(r.row.surveyId) ?? "",
        severity: r.row.severity,
        href: `/alerts?case=${r.row.id}`,
      })),
    },
    {
      kind: "case.resolved" as const,
      count: resolved.length,
      items: resolved.map((r) => ({
        id: r.row.id,
        at: r.row.acknowledgedAt!,
        title: r.patient ? fullNameOf(r.patient) : "—",
        detail: r.row.outcome ?? "",
        severity: r.row.severity,
        href: `/alerts?case=${r.row.id}`,
      })),
    },
    {
      kind: "referral.created" as const,
      count: newReferrals.length,
      items: newReferrals.map((r) => ({
        id: r.row.id,
        at: r.row.createdAt,
        title: r.patient ? fullNameOf(r.patient) : "—",
        detail: r.row.destination,
        severity: null,
        href: `/referrals`,
      })),
    },
    {
      kind: "schedule.run" as const,
      count: runs.length,
      items: runs.map((r) => ({
        id: r.run.id,
        at: r.run.ranAt,
        title: r.schedule.title,
        detail: `${r.run.assigned}`,
        severity: null,
        href: `/schedules`,
      })),
    },
  ].filter((g) => g.count > 0);

  /*
   * Сводка не пишется в журнал доступа. Она не показывает ничего, чего
   * человек не видит на своих экранах, а запись «посмотрел сводку» на каждое
   * открытие панели превратила бы журнал в шум и спрятала бы в нём то, ради
   * чего он существует.
   */
  return c.json({ since, groups });
});
