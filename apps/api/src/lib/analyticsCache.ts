import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { responses } from "../db/schema";

/**
 * Кэш тяжёлой аналитики (8.4).
 *
 * Инвалидация — не по времени, а по данным: ключ включает «отпечаток»
 * методики (число завершённых прохождений и время последней сдачи). Появилось
 * новое прохождение — отпечаток изменился, старая запись больше не найдётся
 * и осядет в LRU. TTL здесь был бы хуже: он и отдаёт устаревшее в первые
 * минуты после сдачи, и пересчитывает зря, когда ничего не менялось.
 *
 * Кэш живёт в процессе: при нескольких репликах каждая греет свой — это
 * дешевле и проще, чем общий Redis ради секунд пересчёта.
 */

const MAX_ENTRIES = 200;
const cache = new Map<string, unknown>();

async function fingerprint(surveyId: string): Promise<string> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)`,
      last: sql<string | null>`max(${responses.submittedAt})`,
    })
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")));
  return `${Number(row?.n ?? 0)}:${row?.last ?? "-"}`;
}

/** Выполнить или отдать из кэша; part различает срезы одной методики */
export async function cached<T>(surveyId: string, part: string, build: () => Promise<T>): Promise<T> {
  const key = `${surveyId}:${part}:${await fingerprint(surveyId)}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;

  const value = await build();
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

/** Для тестов: очистить целиком */
export function clearAnalyticsCache(): void {
  cache.clear();
}
