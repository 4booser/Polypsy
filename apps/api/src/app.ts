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
import { renderError, type ErrorParams } from "@quizzy/shared";
import { langOf } from "./lib/http";
import { checkRls } from "./lib/rlsGuard";
import { env } from "./env";
import { authRoutes } from "./routes/auth";
import { surveyRoutes } from "./routes/surveys";
import { responseRoutes } from "./routes/responses";
import { groupRoutes } from "./routes/groups";
import { patientGroupRoutes } from "./routes/patientGroups";
import { surveyFolderRoutes } from "./routes/surveyFolders";
import { analyticsRoutes } from "./routes/analytics";
import { dashboardRoutes } from "./routes/dashboard";
import { userRoutes } from "./routes/users";
import { auditRoutes } from "./routes/audit";
import { opsSessionRoutes, opsUserRoutes } from "./routes/opsAccounts";
import { alertRoutes } from "./routes/alerts";
import { dynamicsRoutes } from "./routes/dynamics";
import { reportRoutes } from "./routes/reports";
import { accessRoutes } from "./routes/access";
import { clinicRoutes } from "./routes/clinic";
import { messageRoutes } from "./routes/messages";
import { mailingRoutes } from "./routes/mailings";
import { patientRoutes } from "./routes/patients";
import { episodeRoutes } from "./routes/episodes";
import { recordingRoutes } from "./routes/recordings";
import { permissionRoutes } from "./routes/permissions";
import { storageRoutes } from "./routes/storage";
import { timelineRoutes } from "./routes/timeline";
import { consoleRoutes } from "./routes/console";
import { meetRoutes } from "./routes/meet";
import { eventRoutes } from "./routes/events";
import { decisionRoutes } from "./routes/decisions";
import { cohortRoutes } from "./routes/cohorts";
import { filterPresetRoutes } from "./routes/filterPresets";
import { statModelRoutes } from "./routes/statModels";
import { missedRoutes } from "./routes/missed";
import { searchRoutes } from "./routes/search";
import { deviceRoutes } from "./routes/devices";
import { presenceRoutes } from "./routes/presence";
import { viewRoutes } from "./routes/views";
import { noteRoutes } from "./routes/notes";
import { safetyRoutes } from "./routes/safety";
import { pushRoutes } from "./routes/push";
import { alertCaseRoutes } from "./routes/alertCases";
import { worklistRoutes } from "./routes/worklist";
import { metricsRoutes } from "./routes/metrics";
import { buildOpenApi } from "./lib/openapi";
import pkg from "../package.json" with { type: "json" };
import { spssRoutes } from "./routes/spss";
import { batteryRoutes } from "./routes/batteries";
import { inviteRoutes } from "./routes/invites";
import { conclusionRoutes } from "./routes/conclusions";
import { consentRoutes } from "./routes/consents";
import { normRoutes } from "./routes/norms";
import { dataQualityRoutes } from "./routes/dataQuality";
import { facetRoutes } from "./routes/facets";
import { referralRoutes } from "./routes/referrals";
import { templateRoutes } from "./routes/templates";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { requireAuth, requireStaff, type AppEnv } from "./middleware/auth";
import { requestId } from "./middleware/requestId";
import { currentRequestId, log } from "./lib/log";
import { reportError } from "./lib/errorReport";
import { recordError } from "./lib/opsBuffer";
import { opsRoutes } from "./routes/ops";

const app = new Hono<AppEnv>();

/*
 * Идентификатор запроса — первым: он должен стоять в контексте раньше, чем
 * что-либо начнёт писать в лог, иначе первые записи останутся без него.
 */
app.use("*", requestId);
app.use("*", secureHeaders());
// аналитика отдаёт сотни КБ JSON — gzip сокращает их на порядок
app.use("*", compress());
/*
 * Потолок на тело запроса — общий мегабайт и отдельный для аудио приёма.
 *
 * Самый большой легальный JSON — сдача МЛО-200 с потоком событий, ~300 КБ;
 * мегабайта хватает всем с запасом, а бомбу в теле он останавливает. Но под
 * тот же мегабайт попадала и загрузка записи приёма, у которой свой потолок
 * в 200 МБ (см. routes/recordings): общий лимит стоит на «*» и срабатывает
 * РАНЬШЕ маршрута, поэтому проверка размера в маршруте не выполнялась
 * никогда, а часовой разговор упирался в 413. Запись приёма было не
 * загрузить вовсе — молча, без единой строки в логе о причине.
 *
 * Развилка стоит здесь, а не вторым app.use на путь записи: hono выполняет
 * промежуточные слои по порядку регистрации, и общий лимит всё равно
 * сработал бы первым.
 */
const RECORDING_UPLOAD = /^\/api\/recordings\/[^/]+\/stop$/;
const generalLimit = bodyLimit({
  maxSize: 1024 * 1024,
  onError: (c) => c.json({ error: renderError("err.tooLarge", langOf(c)) }, 413),
});
const recordingLimit = bodyLimit({
  // тот же потолок, что проверяет сам маршрут: три часа приёма в сжатом виде
  maxSize: 200 * 1024 * 1024,
  onError: (c) => c.json({ error: renderError("err.tooLarge", langOf(c)) }, 413),
});
app.use("*", (c, next) =>
  (c.req.method === "POST" && RECORDING_UPLOAD.test(c.req.path) ? recordingLimit : generalLimit)(c, next),
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
    /*
     * Заодно отвечаем, действуют ли политики строк.
     *
     * Это состояние развёртывания, а не приложения: оно зависит от того,
     * какой ролью приложение подключено к базе, и снаружи узнать его больше
     * неоткуда. Проверять по журналу («была ли строка при старте») хуже:
     * журнал ротируется, строка одна на весь запуск, и вопрос «а сейчас-то
     * как» остаётся без ответа.
     *
     * Отдаём только «да/нет» и без подробностей: маршрут открыт без
     * авторизации, и рассказывать постороннему, каким пользователем мы
     * ходим в базу, незачем.
     */
    const rls = await checkRls();
    return c.json({ ok: true, rls: !rls.bypasses });
  } catch {
    return c.json({ ok: false, error: renderError("err.dbUnavailable", langOf(c)) }, 503);
  }
});

app.route("/api/auth", authRoutes);
app.route("/api/groups", groupRoutes);
/*
 * Группы ПАЦИЕНТОВ — отдельный путь, а не вложение в /api/groups.
 *
 * Вложить их значило бы, что «группа» в адресе означает то одно, то другое
 * в зависимости от хвоста пути: /api/groups/:id — группа методик,
 * /api/groups/patients/:id — группа людей. Читающий журнал доступа и
 * разбирающий отказ обязаны понимать, о чём речь, по самому адресу.
 */
app.route("/api/patient-groups", patientGroupRoutes);
app.route("/api/surveys", surveyRoutes);
/*
 * Папки МЕТОДИК — отдельный путь, а не /api/surveys/folders.
 *
 * Вложенный путь столкнулся бы с /api/surveys/:id: Hono отдал бы «folders»
 * обработчику методики как её идентификатор, и спасал бы только порядок
 * регистрации маршрутов — правило, которого в файле не видно. И, как у
 * групп пациентов выше, адрес обязан сам говорить, о чём речь: папка — не
 * методика и не группа.
 */
app.route("/api/survey-folders", surveyFolderRoutes);
app.route("/api/analytics", analyticsRoutes);
/* состояние пациентов по направлениям — стартовый экран «Зведення» */
app.route("/api/dashboard", dashboardRoutes);
app.route("/api/users", userRoutes);
/*
 * Техпанель, учётные записи и сессии — под users.manage, а не под ops.read.
 *
 * Стоят РАНЬШЕ наблюдаемости техпанели (/api/ops целиком, свой заслон по
 * ops.read), и порядок здесь — смысл, а не вкус: Hono собирает обработчики в
 * порядке регистрации, и ответ отсюда уходит раньше, чем очередь дойдёт до
 * заслона префикса. Переставь строки — и вкладку «Користувачі» открывало бы
 * право смотреть логи, а не право вести учётки.
 */
app.route("/api/ops/users", opsUserRoutes);
app.route("/api/ops/sessions", opsSessionRoutes);
app.route("/api/audit", auditRoutes);
app.route("/api/alerts", alertRoutes);
app.route("/api/dynamics", dynamicsRoutes);
app.route("/api/reports", reportRoutes);
app.route("/api/access", accessRoutes);
// случаи риска — новый контур разбора; /api/alerts оставлен для совместимости
app.route("/api/alert-cases", alertCaseRoutes);
app.route("/api/worklist", worklistRoutes);
app.route("/api/stats/storage", storageRoutes);
app.route("/api/timeline", timelineRoutes);
app.route("/api/events", eventRoutes);
app.route("/api/console", consoleRoutes);
app.route("/api/meet", meetRoutes);
app.route("/api/presence", presenceRoutes);
app.route("/api/decisions", decisionRoutes);
app.route("/api/devices", deviceRoutes);
app.route("/api/cohorts", cohortRoutes);
/*
 * Раздел «Статистика» — два адреса, а не один с хвостами: пресет фильтров
 * живёт отдельно от модели (на него ссылаются несколько), и читающий журнал
 * обязан по адресу понимать, что правили — срез или модель.
 */
app.route("/api/filter-presets", filterPresetRoutes);
app.route("/api/stat-models", statModelRoutes);
app.route("/api/search", searchRoutes);
app.route("/api/missed", missedRoutes);
app.route("/api/views", viewRoutes);
app.route("/api/notes", noteRoutes);
app.route("/api/safety", safetyRoutes);
app.route("/api/push", pushRoutes);
// метрики вне /api: их снимает сборщик, а не консоль
app.route("/metrics", metricsRoutes);
/*
 * Техпанель для разработчиков: то же состояние, что в /metrics и логе, но
 * для человека в консоли — под правом ops.read, а не под общим секретом.
 */
app.route("/api/ops", opsRoutes);

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
app.route("/api/spss", spssRoutes);
app.route("/api/batteries", batteryRoutes);
app.route("/api/invites", inviteRoutes);
app.route("/api/conclusions", conclusionRoutes);
app.route("/api/consents", consentRoutes);
app.route("/api/norms", normRoutes);
app.route("/api/data-quality", dataQualityRoutes);
app.route("/api/facets", facetRoutes);
app.route("/api/clinic", clinicRoutes);
app.route("/api/messages", messageRoutes);
/*
 * Рассылки — отдельный путь, а не /api/messages/mailings.
 *
 * Переписка и рассылка — разные вещи под одним словом «Повідомлення» на
 * макете: разговор двоих и объявление списку. Вложенный путь столкнулся бы
 * с /api/messages/:id (Hono отдал бы «mailings» обработчику разговора как
 * его идентификатор), а читающий журнал обязан понимать по адресу, о чём
 * речь.
 */
app.route("/api/mailings", mailingRoutes);
/*
 * Пациенты зоны видимости и карточка пациента. До сих пор список людей жил
 * под /api/access/patients (закрыт assignments.manage — правом назначать, а
 * не видеть) и /api/dynamics/respondents (только обследованные). Раздел
 * «Пацієнти» макета — про всех, кого сотрудник вправе видеть, и адрес
 * называет это прямо.
 */
app.route("/api/patients", patientRoutes);
app.route("/api/episodes", episodeRoutes);
app.route("/api/recordings", recordingRoutes);
app.route("/api/permissions", permissionRoutes);
app.route("/api/referrals", referralRoutes);
app.route("/api/templates", templateRoutes);
app.route("/api", responseRoutes);

app.onError((err, c) => {
  const id = currentRequestId();
  if (err instanceof HTTPException) {
    /*
     * Единственное место, где отказ превращается в текст, — и сразу на языке
     * того, кто спрашивал.
     *
     * Раньше фраза писалась в каждом маршруте по-русски и уезжала клиенту
     * готовой: словарь интерфейса такие строки не видит, переключатель языка
     * на них не действует. Украиноязычный пациент читал «Вы уже проходили
     * эту методику» на украинском экране.
     *
     * Отказы без ключа — разбор тела запроса — проходят как есть: там текст
     * собирается на месте и адресован разработчику.
     */
    const info = err.cause as { key?: string; params?: ErrorParams } | undefined;
    const text = info?.key ? renderError(info.key, langOf(c), info.params) : err.message;
    // ожидаемые отказы — не ошибки сервера, стек тут не нужен
    return c.json({ error: text, requestId: id }, err.status);
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
  /*
   * Та же ошибка — в группы техпанели (lib/opsBuffer.ts): сборщик ошибок
   * включается SENTRY_DSN и на маленькой установке часто не настроен, а
   * смотреть, что падает, нужно и там. Маршрут — шаблоном, как в сборщик.
   */
  recordError({
    error: err,
    method: c.req.method,
    route: c.req.routePath ?? null,
    code: 500,
    requestId: id,
  });
  log.error("unhandled", {
    path: c.req.path,
    method: c.req.method,
    name: err.name,
    // сообщение и стек — в лог, наружу не отдаём: там бывают имена таблиц
    message: err.message,
    stack: err.stack?.split("\n").slice(0, 6).join(" | "),
  });
  return c.json({ error: renderError("err.internal", langOf(c)), requestId: id }, 500);
});

app.notFound((c) =>
  c.json({ error: renderError("err.routeNotFound", langOf(c)), requestId: currentRequestId() }, 404),
);

export { app };
