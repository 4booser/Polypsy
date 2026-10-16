import { sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { env } from "../env";
import { auditSystem } from "./audit";
import { log } from "./log";
import { registerJob, trackJob } from "./opsJobs";

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
 *
 * Тем же тиком — мёртвые семьи refresh-токенов (purgeRefreshTokens, #205).
 */

const BATCH = 5000;

/** Проход ретенции целиком: поток событий и мёртвые семьи refresh-токенов; итог — удалённых строк всего */
export async function runRetentionOnce(now = new Date()): Promise<number> {
  return (await purgeAnswerEvents(now)) + (await purgeRefreshTokens(now));
}

async function purgeAnswerEvents(now: Date): Promise<number> {
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

/* ─────────── refresh-токены: мёртвые семьи (#205) ─────────── */

/**
 * Сколько дней хранится семья refresh-токенов после своей смерти.
 *
 * Каждый обмен пары — новая строка (lib/refresh.ts), и погашенные строки
 * никто не убирал: на цели их ~1,3 млн. Удаляется только то, что для
 * обнаружения кражи больше не нужно, — семья целиком и только мёртвая:
 * каждый её токен отозван или истёк, и случилось это раньше N дней назад.
 * Момент смерти семьи — позднейший из моментов, когда её строки перестали
 * действовать: max(least(revoked_at, expires_at)). least() пропускает NULL,
 * так что у неотозванной строки это её срок. Именно least, а не «отзыв, а
 * если его нет — срок»: смена пароля (revokeAllFor) отзывает у человека все
 * строки, и давно истёкшие тоже, — давно мёртвая семья от этого не оживает.
 *
 * Живая семья не трогается вовсе, сколь бы старыми ни были её погашенные
 * строки. Погашенный токен на руках у жертвы бывает сколь угодно старым:
 * вор, обменявший копию первым, держит цепочку живой, а жертва возвращается
 * через месяц без связи — и повтор её токена должен погасить семью вора
 * (CR-072). Повтор rotateRefresh проверяет раньше срока, и строка для этого
 * нужна, пока семья жива.
 *
 * Окно повтора потерянного обмена (#144, RETRY_WINDOW_MS — 5 минут) и срок
 * жизни refresh (REFRESH_TTL_DAYS — 30 дней) лежат внутри жизни семьи: окну
 * нужен живой преемник, сроку — неистёкший токен. N отсчитывается от смерти
 * семьи, поэтому оба покрыты при любом N > 0. После смерти предъявление
 * любого её токена не даёт ничего — ни со строкой (отказ «отозван» или
 * «повтор»), ни без неё («неизвестен»): ответ один и тот же, 401. Разница —
 * только в причине строки журнала auth.refresh_failed и в сдвиге границы
 * access-токенов при повторе в истёкшей семье, а он уже ничего не защищает:
 * access живёт полчаса, а семья мертва N дней.
 *
 * N = 90 — из-за отчёта «Використання» техпанели (lib/opsData.ts,
 * usageReport): «активні люди» читают refresh_tokens.created_at за окно до
 * 90 дней. Каждая строка семьи выдана не позже её смерти, а смерть — раньше
 * now − 90 дней, то есть раньше начала самого широкого окна: отчёт от
 * чистки не меняется. И квартал истории «чья сессия, когда кончилась» для
 * разбора случая — втрое против срока самой сессии.
 */
export const REFRESH_RETENTION_DAYS = 90;

/** Семей в одной порции: строк в семье — по одной на обмен, от единиц до тысяч */
const FAMILY_BATCH = 500;

/**
 * Мёртвые семьи — порциями, каждая в своей транзакции (как у потока событий).
 *
 * Мёртвая семья не оживает: отозванную строку ничто не возвращает, а
 * истёкший токен rotateRefresh не обменивает — новых строк в ней не
 * появится, и проход, прерванный посередине, ничего не портит.
 *
 * Отбираются строки, выданные до границы: у семьи, которая может попасть
 * под чистку, все строки выданы раньше её смерти. Строка, выданная после
 * границы, делает семью живой — её ищет not exists по индексу семьи
 * (family_id, created_at). Семьи план идёт тем же индексом, по порядку, и
 * останавливается на пятисотой подходящей: на 1,3 млн строк отбор порции —
 * миллисекунды, а с удалением (план берёт хеш-соединение по всей таблице)
 * порция — около 0,2 с. Для суточной задачи это приемлемо.
 */
export async function purgeRefreshTokens(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - REFRESH_RETENTION_DAYS * 86_400_000).toISOString();
  let rows = 0;
  let families = 0;
  for (;;) {
    const batch = await systemContext(baseDb, async () => {
      const deleted = await db.execute<{ family_id: string }>(sql`
        with dead as (
          select f.family_id
            from refresh_tokens f
           where f.created_at < ${cutoff}
           group by f.family_id
          having max(least(f.revoked_at, f.expires_at)) < ${cutoff}
             and not exists (
               select 1 from refresh_tokens n where n.family_id = f.family_id and n.created_at >= ${cutoff}
             )
           limit ${FAMILY_BATCH}
        )
        delete from refresh_tokens t using dead
         where t.family_id = dead.family_id
        returning t.family_id`);
      return { rows: deleted.length, families: new Set([...deleted].map((r) => r.family_id)).size };
    });
    rows += batch.rows;
    families += batch.families;
    if (batch.families < FAMILY_BATCH) break;
  }

  if (rows > 0) {
    await systemContext(baseDb, () =>
      auditSystem({
        action: "retention.refresh_tokens",
        details: { deleted: rows, families, olderThanDays: REFRESH_RETENTION_DAYS },
      }),
    );
  }
  return rows;
}

/** Суточный тик: ретенция меряется месяцами, чаще нет смысла */
export function startRetention(intervalMs = 24 * 3_600_000): () => void {
  /* суточный такт — в реестр техпанели (opsJobs.ts): «чистка вообще идёт?» */
  registerJob("retention", intervalMs);
  const tick = () => {
    trackJob("retention", () => runRetentionOnce()).catch((error) =>
      log.error("retention.failed", { error: String(error) }),
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
