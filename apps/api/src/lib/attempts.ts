import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { responses, surveyAccess } from "../db/schema";
import { badRequest } from "./http";

/**
 * Отказать, если попытки по назначению кончились.
 *
 * Молчит, если назначения нет: методику, которую человек проходит сам,
 * никто не ограничивал, и переносить на неё правило из чужого назначения
 * было бы подменой.
 */
export async function assertAttemptsLeft(userId: string, surveyId: string): Promise<void> {
  const [grant] = await db
    .select({ allowed: surveyAccess.attemptsAllowed, grantedAt: surveyAccess.grantedAt })
    .from(surveyAccess)
    .where(
      and(
        eq(surveyAccess.userId, userId),
        eq(surveyAccess.surveyId, surveyId),
        or(isNull(surveyAccess.expiresAt), gt(surveyAccess.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);
  if (!grant) return;
  // не ограничивали — значит и нечего проверять
  if (grant.allowed === null) return;

  /*
   * Считаются прохождения ПОСЛЕ выдачи назначения.
   *
   * Прошлогоднее прохождение той же методики не тратит сегодняшнюю попытку:
   * назначили — значит хотят измерить сейчас, а не зачесть старое.
   */
  const [used] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(responses)
    .where(
      and(
        eq(responses.userId, userId),
        eq(responses.surveyId, surveyId),
        eq(responses.status, "completed"),
        gt(responses.submittedAt, grant.grantedAt),
      ),
    );

  if (Number(used?.n ?? 0) >= grant.allowed) {
    badRequest("err.attemptsSpent", { allowed: grant.allowed });
  }
}
