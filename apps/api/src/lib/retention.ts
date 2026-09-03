import { sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { env } from "../env";
import { auditSystem } from "./audit";
import { log } from "./log";

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

const BATCH = 5000;

export async function runRetentionOnce(now = new Date()): Promise<number> {
  if (env.answerEventsRetentionDays <= 0) return 0; // ретенция выключена

  const cutoff = new Date(now.getTime() - env.answerEventsRetentionDays * 86_400_000).toISOString();

  /*
   * Порциями — и КАЖДАЯ порция в своей транзакции.
   *
   * Порции задумывались, чтобы не держать блокировку и не раздувать WAL
   * одной гигантской DELETE, но весь проход шёл внутри одного
   * systemContext, то есть внутри одной транзакции: строки не
   * освобождались до самого конца, WAL не переиспользовался, autovacuum не
   * мог убрать ни одной удалённой версии, — и порции не давали ровно того,
   * ради чего заведены. На годовой таблице это часы одной открытой
   * транзакции.
   *
   * Плата за отдельные транзакции — проход прерываем: упав на пятой порции,
   * мы оставляем четыре удалёнными. Для чистки по сроку это правильное
   * поведение: следующий суточный тик доберёт остаток.
   */
  let total = 0;
  for (;;) {
    const deleted = await systemContext(baseDb, async () => {
      const rows = await db.execute(sql`
        delete from answer_events
        where id in (
          select ae.id from answer_events ae
          join responses r on r.id = ae.response_id
          where r.submitted_at is not null and r.submitted_at < ${cutoff}
          limit ${BATCH}
        )
        returning id`);
      return rows.length;
    });
    total += deleted;
    if (deleted < BATCH) break;
  }

  if (total > 0) {
    await systemContext(baseDb, () =>
      auditSystem({
        action: "retention.answer_events",
        details: { deleted: total, olderThanDays: env.answerEventsRetentionDays },
      }),
    );
  }
  return total;
}


/** Суточный тик: ретенция меряется месяцами, чаще нет смысла */
export function startRetention(intervalMs = 24 * 3_600_000): () => void {
  const tick = () => {
    runRetentionOnce().catch((error) => log.error("retention.failed", { error: String(error) }));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
