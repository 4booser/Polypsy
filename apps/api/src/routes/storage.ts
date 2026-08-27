import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth, requireSuperadmin, type AppEnv } from "../middleware/auth";

/**
 * Размеры таблиц и рост журнала.
 *
 * Журнал доступа и телеметрия ответов растут линейно от нагрузки и не
 * чистятся: журнал по замыслу неудаляем, телеметрия сворачивается только по
 * истечении срока хранения. На VPS с одним диском это заканчивается
 * остановкой базы — и узнать об этом хочется заранее, а не по отказу записи.
 */
export const storageRoutes = new Hono<AppEnv>();

storageRoutes.use("*", requireAuth, requireSuperadmin);

interface TableSize extends Record<string, unknown> {
  table: string;
  rows: number;
  totalBytes: number;
  /** Человекочитаемо: «412 MB» */
  totalPretty: string;
}

storageRoutes.get("/", async (c) => {
  /*
   * n_live_tup из статистики планировщика, а не count(*): точный подсчёт по
   * каждой таблице на большой базе сам по себе заметная нагрузка, а для
   * «сколько у нас всего» оценки достаточно.
   */
  const tables = await db.execute<TableSize>(sql`
    select
      c.relname                                    as "table",
      coalesce(s.n_live_tup, 0)::int               as rows,
      pg_total_relation_size(c.oid)::bigint        as "totalBytes",
      pg_size_pretty(pg_total_relation_size(c.oid)) as "totalPretty"
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind = 'r'
    order by pg_total_relation_size(c.oid) desc
  `);

  const [database] = await db.execute<{ bytes: number; pretty: string } & Record<string, unknown>>(sql`
    select pg_database_size(current_database())::bigint as bytes,
           pg_size_pretty(pg_database_size(current_database())) as pretty
  `);

  // рост журнала по месяцам: по нему видно, когда пора думать о партиционировании
  const auditGrowth = await db.execute<{ month: string; entries: number } & Record<string, unknown>>(sql`
    select to_char(date_trunc('month', at), 'YYYY-MM') as month,
           count(*)::int                               as entries
    from audit_log
    where at > now() - interval '12 months'
    group by 1
    order by 1
  `);

  /*
   * bigint приходит из драйвера строкой — иначе большие значения теряли бы
   * точность. Байты базы до петабайта укладываются в number без потерь,
   * поэтому на выходе приводим явно: клиенту нужны числа, а не строки.
   */
  return c.json({
    database: {
      bytes: Number(database?.bytes ?? 0),
      pretty: String(database?.pretty ?? "0 bytes"),
    },
    tables: [...tables].map((t) => ({
      table: String(t.table),
      rows: Number(t.rows),
      totalBytes: Number(t.totalBytes),
      totalPretty: String(t.totalPretty),
    })),
    auditGrowth: [...auditGrowth].map((r) => ({
      month: String(r.month),
      entries: Number(r.entries),
    })),
  });
});
