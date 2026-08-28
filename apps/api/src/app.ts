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
import { storageRoutes } from "./routes/storage";
import { timelineRoutes } from "./routes/timeline";
import { eventRoutes } from "./routes/events";
import { viewRoutes } from "./routes/views";
import { pathwayRoutes } from "./routes/pathways";
import { noteRoutes } from "./routes/notes";
import { safetyRoutes } from "./routes/safety";
import { goalRoutes } from "./routes/goals";
import { pushRoutes } from "./routes/push";
import { alertCaseRoutes } from "./routes/alertCases";
import { worklistRoutes } from "./routes/worklist";
import { unitReportRoutes } from "./routes/unitReport";
import { metricsRoutes } from "./routes/metrics";
import { buildOpenApi } from "./lib/openapi";
import pkg from "../package.json" with { type: "json" };
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
import { calibrationRoutes } from "./routes/calibration";
import { dataQualityRoutes } from "./routes/dataQuality";
import { facetRoutes } from "./routes/facets";
import { referralRoutes } from "./routes/referrals";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { requireAuth, requireStaff, type AppEnv } from "./middleware/auth";
import { requestId } from "./middleware/requestId";
import { currentRequestId, log } from "./lib/log";
import { reportError } from "./lib/errorReport";

const app = new Hono<AppEnv>();

/*
 * Идентификатор запроса — первым: он должен стоять в контексте раньше, чем
 * что-либо начнёт писать в лог, иначе первые записи останутся без него.
 */
app.use("*", requestId);
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
// случаи риска — новый контур разбора; /api/alerts оставлен для совместимости
app.route("/api/alert-cases", alertCaseRoutes);
app.route("/api/worklist", worklistRoutes);
app.route("/api/unit-report", unitReportRoutes);
app.route("/api/stats/storage", storageRoutes);
app.route("/api/timeline", timelineRoutes);
app.route("/api/events", eventRoutes);
app.route("/api/views", viewRoutes);
app.route("/api/pathways", pathwayRoutes);
app.route("/api/notes", noteRoutes);
app.route("/api/safety", safetyRoutes);
app.route("/api/goals", goalRoutes);
app.route("/api/push", pushRoutes);
// метрики вне /api: их снимает сборщик, а не консоль
app.route("/metrics", metricsRoutes);

/**
 * Описание API. За логином сотрудника: перечень эндпоинтов вместе с
 * требуемыми ролями — это карта поверхности атаки, и выкладывать её наружу
 * незачем.
 *
 * Документ собирается из живой таблицы маршрутов при каждом запросе, так что
 * разойтись с кодом он не может.
 */
app.get("/api/openapi.json", requireAuth, requireStaff, (c) =>
  c.json(buildOpenApi(app.routes, pkg.version)),
);
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
app.route("/api/calibration", calibrationRoutes);
app.route("/api/data-quality", dataQualityRoutes);
app.route("/api/facets", facetRoutes);
app.route("/api/referrals", referralRoutes);
app.route("/api", responseRoutes);

app.onError((err, c) => {
  const id = currentRequestId();
  if (err instanceof HTTPException) {
    // ожидаемые отказы — не ошибки сервера, стек тут не нужен
    return c.json({ error: err.message, requestId: id }, err.status);
  }
  /*
   * Номер запроса возвращается пользователю вместе с отказом: по нему
   * инцидент находится в логе одним поиском, вместо пересказа «вчера
   * вечером что-то не сохранилось».
   */
  void reportError({
    error: err,
    route: c.req.routePath ?? c.req.path,
    method: c.req.method,
    role: (c.get("user") as { role?: string } | undefined)?.role,
  });
  log.error("unhandled", {
    path: c.req.path,
    method: c.req.method,
    name: err.name,
    // сообщение и стек — в лог, наружу не отдаём: там бывают имена таблиц
    message: err.message,
    stack: err.stack?.split("\n").slice(0, 6).join(" | "),
  });
  return c.json({ error: "Внутренняя ошибка сервера", requestId: id }, 500);
});

app.notFound((c) => c.json({ error: "Маршрут не найден", requestId: currentRequestId() }, 404));

export { app };
