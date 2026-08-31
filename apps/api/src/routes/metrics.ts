import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { render, setGauge } from "../lib/metrics";
import { env } from "../env";
import { unauthorized } from "../lib/http";

/**
 * Метрики для Prometheus.
 *
 * Закрыты общим секретом, а не логином сотрудника: сборщик метрик — не
 * человек, у него нет сессии, а выкладывать наружу состояние системы
 * незачем. Если METRICS_TOKEN не задан, эндпоинт отвечает 404 — выключено
 * значит выключено, а не «открыто для всех».
 */
export const metricsRoutes = new Hono();

metricsRoutes.get("/", async (c) => {
  const token = process.env.METRICS_TOKEN;
  if (!token) return c.notFound();
  const given = c.req.header("authorization")?.replace(/^Bearer /, "");
  if (given !== token) unauthorized("err.metricsTokenRequired");

  /*
   * Значения, которые дешевле спросить у базы в момент сбора, чем считать
   * на каждом запросе. Три оповещения, ради которых это и нужно:
   * планировщик встал, случаи копятся, диск кончается.
   */
  const [row] = await db.execute<{
    open_cases: number;
    stale_minutes: number | null;
    db_bytes: number;
    audit_rows: number;
  } & Record<string, unknown>>(sql`
    select
      (select count(*)::int from alert_cases where acknowledged_at is null)          as open_cases,
      (select extract(epoch from (now() - max(ran_at))) / 60
         from schedule_runs)                                                           as stale_minutes,
      pg_database_size(current_database())::bigint                                    as db_bytes,
      (select count(*)::int from audit_log)                                           as audit_rows
  `);

  setGauge("quizzy_open_alert_cases", Number(row?.open_cases ?? 0));
  setGauge("quizzy_database_bytes", Number(row?.db_bytes ?? 0));
  setGauge("quizzy_audit_entries", Number(row?.audit_rows ?? 0));
  // null означает «планировщик ни разу не тикал» — это тоже повод для тревоги
  setGauge("quizzy_scheduler_stale_minutes", Number(row?.stale_minutes ?? -1));
  setGauge("quizzy_uptime_seconds", Math.round(process.uptime()));
  setGauge("quizzy_build_info", 1, { env: env.isProduction ? "production" : "development" });

  return c.text(render(), 200, { "content-type": "text/plain; version=0.0.4" });
});
