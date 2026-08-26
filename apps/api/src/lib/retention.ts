import { sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { auditSystem } from "./audit";

/**
 * Ретенция сырого потока событий.
 *
 * answer_events — самая быстрорастущая таблица (каждое переключение ответа).
 * Для психометрии агрегаты уже сняты в answers (durationMs, changeCount,
 * visitCount); сырой поток нужен для разбора конкретных прохождений и
 * исследовательских выгрузок — но не вечно. По истечении срока события
 * прохождения удаляются; агрегаты и сами ответы остаются навсегда.
 *
 * Запуск — суточный тик по образцу планировщика; каждая чистка оставляет
 * след в журнале с числом удалённых строк.
 */

export async function runRetentionOnce(now = new Date()): Promise<number> {
  if (env.answerEventsRetentionDays <= 0) return 0; // ретенция выключена

  const cutoff = new Date(now.getTime() - env.answerEventsRetentionDays * 86_400_000).toISOString();

  // порциями: одна гигантская DELETE держала бы блокировку и WAL
  let total = 0;
  for (;;) {
    const rows = await db.execute(sql`
      delete from answer_events
      where id in (
        select ae.id from answer_events ae
        join responses r on r.id = ae.response_id
        where r.submitted_at is not null and r.submitted_at < ${cutoff}
        limit 5000
      )
      returning id`);
    total += rows.length;
    if (rows.length < 5000) break;
  }

  if (total > 0) {
    await auditSystem({
      action: "retention.answer_events",
      details: { deleted: total, olderThanDays: env.answerEventsRetentionDays },
    });
  }
  return total;
}

/** Суточный тик: ретенция меряется месяцами, чаще нет смысла */
export function startRetention(intervalMs = 24 * 3_600_000): () => void {
  const tick = () => {
    runRetentionOnce().catch((error) => console.error("Ретенция упала", error));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
