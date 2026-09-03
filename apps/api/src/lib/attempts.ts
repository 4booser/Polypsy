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

/**
 * Списать попытку — атомарно, одним оператором.
 *
 * Проверка чтением (`assertAttemptsLeft` выше) неустранимо гоночная: две
 * одновременные отправки — пациент дважды нажал «отправить», клиент
 * повторил по таймауту — обе видят «использовано 0 из 1» и обе проходят.
 * В базе оказываются два завершённых прохождения при одной разрешённой
 * попытке, и второе попадает в динамику, в RCI и в выборку норм. Для
 * методики с ограничением попыток это прямая порча измерения: человек
 * помнит вопросы.
 *
 * Возвращает ложь, если попытки кончились. Вызывается ВНУТРИ транзакции
 * сдачи — иначе списание и прохождение могут разъехаться.
 */
export async function consumeAttempt(
  tx: typeof db,
  userId: string,
  surveyId: string,
): Promise<boolean> {
  const taken = await tx
    .update(surveyAccess)
    .set({ attemptsUsed: sql`${surveyAccess.attemptsUsed} + 1` })
    .where(
      and(
        eq(surveyAccess.userId, userId),
        eq(surveyAccess.surveyId, surveyId),
        or(isNull(surveyAccess.expiresAt), gt(surveyAccess.expiresAt, sql`now()`)),
        // ограничения нет — списывать нечего, но и отказывать не за что
        or(
          isNull(surveyAccess.attemptsAllowed),
          sql`${surveyAccess.attemptsUsed} < ${surveyAccess.attemptsAllowed}`,
        ),
      ),
    )
    .returning({ userId: surveyAccess.userId });

  if (taken.length) return true;

  /*
   * Ноль строк означает одно из трёх, и различать их надо аккуратно:
   * «попытки кончились», «назначения нет вовсе» и «назначение просрочено».
   *
   * Второе и третье — не отказ. Методику можно пройти и без назначения,
   * если доступ дан иначе, а просроченное назначение ничего не ограничивает
   * (так же считал и прежний код: он просто не находил такой строки и
   * пропускал проверку). Первая редакция этого не различала и отказывала
   * при просроченном назначении — то есть чинила гонку, ломая обычный путь.
   *
   * Гонки здесь уже нет: решение принято оператором выше, это только
   * объяснение нуля строк.
   */
  const [live] = await tx
    .select({ used: surveyAccess.attemptsUsed, allowed: surveyAccess.attemptsAllowed })
    .from(surveyAccess)
    .where(
      and(
        eq(surveyAccess.userId, userId),
        eq(surveyAccess.surveyId, surveyId),
        or(isNull(surveyAccess.expiresAt), gt(surveyAccess.expiresAt, sql`now()`)),
      ),
    )
    .limit(1);
  return !live || live.allowed === null;
}
