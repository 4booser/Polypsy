/**
 * Сборка HTTP-приложения без побочных эффектов процесса.
 *
 * Планировщик, обработчики сигналов и прослушивание порта живут в index.ts:
 * тесты дергают app.request() напрямую, и запуск фоновых процессов при
 * импорте превращал бы каждый тест в гонку с планировщиком.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { compress } from "hono/compress";
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
import { inviteRoutes } from "./routes/invites";
import { kioskRoutes } from "./routes/kiosk";
import { conclusionRoutes } from "./routes/conclusions";
import { consentRoutes } from "./routes/consents";
import { normRoutes } from "./routes/norms";
import { surveillanceRoutes } from "./routes/surveillance";
import { difRoutes } from "./routes/dif";
import { db } from "./db";
import { sql } from "drizzle-orm";
import type { AppEnv } from "./middleware/auth";

const app = new Hono<AppEnv>();

app.use("*", logger());
app.use("*", secureHeaders());
// аналитика отдаёт сотни КБ JSON — gzip сокращает их на порядок
app.use("*", compress());
// самый большой легальный запрос — сдача МЛО-200 с потоком событий, ~300 КБ;
// мегабайта хватает всем с запасом, а бомбу в теле он останавливает
app.use(
  "*",
  bodyLimit({
    maxSize: 1024 * 1024,
    onError: (c) => c.json({ error: "Слишком большой запрос" }, 413),
  }),
);
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
app.route("/api/invites", inviteRoutes);
app.route("/api/kiosk", kioskRoutes);
app.route("/api/conclusions", conclusionRoutes);
app.route("/api/consents", consentRoutes);
app.route("/api/norms", normRoutes);
app.route("/api/surveillance", surveillanceRoutes);
app.route("/api/dif", difRoutes);
app.route("/api", responseRoutes);

app.onError((err, c) => {
  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }
  console.error(err);
  return c.json({ error: "Внутренняя ошибка сервера" }, 500);
});

app.notFound((c) => c.json({ error: "Маршрут не найден" }, 404));

export { app };
