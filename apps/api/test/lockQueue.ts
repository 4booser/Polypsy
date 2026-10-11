import { sql } from "drizzle-orm";
import { db } from "./fixtures";

/**
 * Очередь за замком — по pg_stat_activity, а не по таймеру (волна 21).
 *
 * Тот же приём, что в guardRaces.test.ts и refreshRevokeRace.test.ts:
 * строку или замок держит отдельное соединение, запросы запускаются по
 * одному и каждый дожидается, пока встанет в очередь; порядок в очереди —
 * порядок прохода. Здесь — общим местом для файлов гонок волны 21.
 */

/**
 * Сколько запросов к этой базе стоят в очереди за замком — из тех, чей
 * текст содержит один из фрагментов. Фрагменты, а не одно имя: до правки и
 * после неё запрос встаёт в очередь разными операторами.
 */
export async function lockWaiters(fragments: string[]): Promise<number> {
  const [row] = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()
      and query ilike any (array[${sql.join(
        fragments.map((f) => sql`${`%${f}%`}`),
        sql`, `,
      )}]::text[])
  `);
  return Number(row?.n ?? 0);
}

/** Дождаться, пока в очереди окажется n запросов */
export async function untilWaiting(n: number, fragments: string[], timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await lockWaiters(fragments)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`в очереди за замком меньше ${n} запросов — гонка не воспроизведена`);
}

/**
 * Дождаться, пока запрос либо встанет в очередь n-м, либо завершится сам.
 *
 * Для запросов, которые на прежнем коде за замком не стоят вовсе: проверка
 * должна увидеть и это — иначе на прежнем коде она падала бы на ожидании, а
 * не на гонке.
 */
export async function queuedOrDone(
  p: Promise<unknown>,
  n: number,
  fragments: string[],
  timeoutMs = 20_000,
): Promise<void> {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (done || (await lockWaiters(fragments)) >= n) return;
    await Bun.sleep(10);
  }
  throw new Error(`запрос ни встал в очередь, ни завершился за ${timeoutMs} мс`);
}
