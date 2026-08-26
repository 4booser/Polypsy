import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { env } from "./env";
import { authRoutes } from "./routes/auth";
import { surveyRoutes } from "./routes/surveys";
import { responseRoutes } from "./routes/responses";
import { groupRoutes } from "./routes/groups";
import { analyticsRoutes } from "./routes/analytics";
import { userRoutes } from "./routes/users";
import { auditRoutes } from "./routes/audit";
import { alertRoutes } from "./routes/alerts";
import { dynamicsRoutes } from "./routes/dynamics";
import { reportRoutes } from "./routes/reports";
import { accessRoutes } from "./routes/access";
import { comparisonRoutes } from "./routes/comparison";
import { spssRoutes } from "./routes/spss";
import { batteryRoutes } from "./routes/batteries";
import { scheduleRoutes } from "./routes/schedules";
import { startScheduler } from "./lib/scheduler";
import { client, db } from "./db";
import { sql } from "drizzle-orm";
import type { AppEnv } from "./middleware/auth";

const app = new Hono<AppEnv>();

app.use("*", logger());
// consola токенов живёт в localStorage, поэтому открытый CORS означал бы, что
// любой сайт может ходить в API от имени залогиненного сотрудника
app.use(
  "*",
  cors({
    origin: (origin) => (env.corsOrigins.includes(origin) ? origin : null),
  }),
);

/**
 * Liveness: процесс жив. Readiness: жив И база отвечает — балансировщику
 * бессмысленно слать трафик на процесс с упавшим Postgres.
 */
app.get("/health", (c) => c.json({ ok: true, uptime: process.uptime() }));
app.get("/health/ready", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: "База данных недоступна" }, 503);
  }
});

app.route("/api/auth", authRoutes);
app.route("/api/groups", groupRoutes);
app.route("/api/surveys", surveyRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/users", userRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/alerts", alertRoutes);
app.route("/api/dynamics", dynamicsRoutes);
app.route("/api/reports", reportRoutes);
app.route("/api/access", accessRoutes);
app.route("/api/compare", comparisonRoutes);
app.route("/api/spss", spssRoutes);
app.route("/api/batteries", batteryRoutes);
app.route("/api/schedules", scheduleRoutes);
app.route("/api", responseRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Внутренняя ошибка сервера" }, 500);
});

app.notFound((c) => c.json({ error: "Маршрут не найден" }, 404));

// расписания меряются днями, поэтому часового тика достаточно; первый проход
// идёт сразу при старте, чтобы простой сервера не сдвигал выдачу заданий.
// Флаг выключает тик на репликах, где он не нужен.
const stopScheduler = env.schedulerEnabled ? startScheduler() : null;

/**
 * Аккуратная остановка: сначала гасим планировщик (чтобы не начать выдачу
 * заданий посреди выключения), затем закрываем пул — Postgres получает
 * нормальное завершение сессий вместо обрыва.
 */
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Получен ${signal}, останавливаюсь`);
  stopScheduler?.();
  await client.end({ timeout: 5 }).catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

export default {
  port: env.port,
  fetch: app.fetch,
};
