import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  featureFlagUpdateSchema,
  serviceStatusInputSchema,
  type FlagAudienceOptions,
  type OpsServiceStatus,
} from "@quizzy/shared";
import { db } from "../db";
import { departments, roles, serviceAnnouncements, surveyGroups, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { enabledFlagsFor, flagChanges, listFlags, saveFlag } from "../lib/featureFlags";
import { badRequest, parseBody, parseQuery } from "../lib/http";
import { dispatchDeploy, knownRepo, listReleases } from "../lib/releases";
import { announce, composeStatus, currentAnnouncement, publicStatus, toAnnouncement } from "../lib/serviceStatus";
import { env } from "../env";
import { requireAuth, requirePermission, type AppEnv } from "../middleware/auth";

/*
 * Техпанель, эксплуатация (волна 10, участок maint): режим обслуживания и
 * объявления о состоянии, флаги функций, история выкаток.
 *
 * Три набора маршрутов в одном файле, потому что это одна работа — «как
 * система работает для людей прямо сейчас»:
 *
 *   GET /api/status        — открыт без входа: страница статуса и баннер;
 *   GET /api/flags         — любому вошедшему: какие флаги включены ему;
 *   /api/ops/maint/*       — техпанель: ops.read смотрит, ops.manage меняет.
 */

/* ═══════════ /api/status — без входа ═══════════ */

export const serviceStatusRoutes = new Hono<AppEnv>();

/**
 * Состояние системы для людей.
 *
 * Открыт без входа: страницу статуса открывают со экрана входа — ровно
 * тогда, когда войти не получается, — и баннер нужен и там. Поэтому в
 * ответе ничего сверх того, что можно сказать постороннему: состояние,
 * текст объявления, время, история объявлений. Ни авторов, ни версии, ни
 * адресов, ни текста ошибок базы.
 */
serviceStatusRoutes.get("/", async (c) => {
  // кэш на стороне клиента не нужен и вреден: страницу открывают, чтобы узнать «сейчас»
  c.header("Cache-Control", "no-store");
  return c.json(await publicStatus());
});

/* ═══════════ /api/flags — любому вошедшему ═══════════ */

export const featureFlagRoutes = new Hono<AppEnv>();
featureFlagRoutes.use("*", requireAuth);

/**
 * Флаги, включённые мне. Только ключи — кому ещё включён флаг, человеку
 * знать незачем, а клиенту для решения «показать ли» хватает «да/нет».
 */
featureFlagRoutes.get("/", async (c) => c.json({ flags: await enabledFlagsFor(c.get("user")) }));

/* ═══════════ /api/ops/maint — техпанель ═══════════ */

export const opsMaintRoutes = new Hono<AppEnv>();

/*
 * Вход — один раз, даже если над этим путём уже стоит общий заслон
 * техпанели (/api/ops/* участка ops). Второй requireAuth открыл бы вторую
 * транзакцию со своим контекстом поверх первой; работало бы, но каждое
 * чтение техпанели стоило бы двух соединений.
 */
const authOnce = createMiddleware<AppEnv>(async (c, next) =>
  c.get("user") ? next() : requireAuth(c, next),
);
opsMaintRoutes.use("*", authOnce);

/* ── режим обслуживания и объявления ── */

opsMaintRoutes.get("/status", requirePermission("ops.read"), async (c) => {
  const current = await publicStatus();
  /*
   * История с авторами — только здесь, за правом ops.read. Автор
   * объявления — подпись под действием с системой, как подпись под
   * распоряжением, а не сведения о человеке в смысле журнала чтений.
   */
  const rows = await db
    .select({ row: serviceAnnouncements, by: users })
    .from(serviceAnnouncements)
    .leftJoin(users, eq(users.id, serviceAnnouncements.createdBy))
    .orderBy(desc(serviceAnnouncements.createdAt))
    .limit(50);
  const body: OpsServiceStatus = {
    current,
    history: rows.map(({ row, by }) => ({ ...toAnnouncement(row), by: by ? fullNameOf(by) : null })),
  };
  return c.json(body);
});

/**
 * Объявить состояние: включить или выключить обслуживание, сообщить о
 * сбоях, снять объявление.
 *
 * Одним маршрутом, а не «включить» и «выключить» отдельно: это одно
 * действие — «вот что сейчас происходит», — и у каждого варианта одни и те
 * же поля. В журнал — своим именем для включения и выключения
 * обслуживания (их ищут чаще всего) и общим для остального.
 */
opsMaintRoutes.post("/status", requirePermission("ops.manage"), async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, serviceStatusInputSchema);
  const previous = await currentAnnouncement().catch(() => null);
  const from = previous?.status ?? "ok";
  const row = await announce(user.id, input);
  const action =
    input.status === "maintenance" && from !== "maintenance"
      ? "ops.maintenance_on"
      : from === "maintenance" && input.status !== "maintenance"
        ? "ops.maintenance_off"
        : "ops.status_set";
  await audit(c, {
    action,
    resourceType: "service_status",
    resourceId: row.id,
    details: { from, to: input.status, expectedEnd: row.expectedEnd, hasMessage: !!row.message },
  });
  /*
   * Ответ собирается из этой же транзакции, а не через publicStatus: та
   * читает отдельным системным соединением и новой строки ещё не видит —
   * человек нажал «увімкнути», а ответ сказал бы «працює».
   */
  const history = await db
    .select()
    .from(serviceAnnouncements)
    .orderBy(desc(serviceAnnouncements.createdAt))
    .limit(10);
  return c.json({ current: composeStatus(row, true, history) }, 201);
});

/* ── флаги функций ── */

opsMaintRoutes.get("/flags", requirePermission("ops.read"), async (c) => {
  const view = await listFlags();
  /*
   * Имена людей в аудиториях — сведения о людях, пусть и о сотрудниках:
   * чтение с именами пишется в журнал. Без имён (флаги на роли и группы)
   * писать нечего — это настройка, а не люди.
   */
  const people = Object.keys(view.names.users).length;
  if (people) {
    await audit(c, { action: "ops.flags_read", resourceType: "feature_flag", details: { people } });
  }
  return c.json(view);
});

const changesQuery = z.object({
  key: z.string().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/* статичный сегмент `changes` не спорит с PUT /flags/:key: у них разные методы */
opsMaintRoutes.get("/flags/changes", requirePermission("ops.read"), async (c) => {
  const q = parseQuery(c, changesQuery);
  return c.json({ items: await flagChanges(q.key, q.limit) });
});

/**
 * Из чего собирать аудиторию: роли лестницы, группы методик, відділення,
 * сотрудники поимённо.
 *
 * За ops.manage, а не ops.read: список нужен только тому, кто правит, а в
 * нём имена и почты всех сотрудников — это данные о людях, и чтение их
 * пишется в журнал. Пациентов в списке нет: адресовать пациента поимённо
 * флагом незачем, для них есть класс «пацієнти» целиком.
 */
opsMaintRoutes.get("/flags/audience", requirePermission("ops.manage"), async (c) => {
  const roleRows = await db.select({ code: roles.code, title: roles.title }).from(roles).orderBy(roles.code);
  const groupRows = await db
    .select({ id: surveyGroups.id, title: surveyGroups.title })
    .from(surveyGroups)
    .where(isNull(surveyGroups.archivedAt))
    .orderBy(surveyGroups.position);
  const departmentRows = await db
    .select({ id: departments.id, title: departments.title })
    .from(departments)
    .where(isNull(departments.archivedAt));
  const staff = await db.select().from(users).where(inArray(users.role, ["admin", "superadmin"]));
  const body: FlagAudienceOptions = {
    staffRoles: roleRows.map((r) => ({ code: r.code, title: r.title })),
    surveyGroups: groupRows,
    departments: departmentRows.map((d) => ({ id: d.id, title: d.title as never })),
    people: staff
      .map((u) => ({ id: u.id, name: fullNameOf(u), email: u.email, role: u.role }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  await audit(c, {
    action: "ops.flag_audience_read",
    resourceType: "feature_flag",
    details: { people: body.people.length },
  });
  return c.json(body);
});

opsMaintRoutes.put("/flags/:key", requirePermission("ops.manage"), async (c) => {
  const user = c.get("user");
  const key = c.req.param("key");
  const input = await parseBody(c.req.raw, featureFlagUpdateSchema);
  const change = await saveFlag(user.id, key, input);
  await audit(c, {
    action: "ops.flag_set",
    resourceType: "feature_flag",
    resourceId: key,
    /*
     * Состав аудитории — числами, а не списком: сам список лежит в истории
     * флага, а журнал доступа отвечает на «кто, что и когда переключил».
     */
    details: {
      enabledBefore: change.before?.enabled ?? false,
      enabled: change.after.enabled,
      all: change.after.audience.all,
      roles: change.after.audience.roles,
      people: change.after.audience.users.length,
      staffRoles: change.after.audience.staffRoles.length,
      surveyGroups: change.after.audience.surveyGroups.length,
      departments: change.after.audience.departments.length,
    },
  });
  return c.json(change);
});

/* ── выкатки ── */

opsMaintRoutes.get("/releases", requirePermission("ops.read"), async (c) => c.json(await listReleases()));

const rollbackSchema = z.object({ version: z.string().min(1).max(120) });

/**
 * Откат на прежний тег прямо из панели — через API GitHub.
 *
 * Только при заданном GITHUB_DISPATCH_TOKEN: без него экран ведёт на
 * страницу запуска в GitHub, и этот маршрут не зовёт. Цель — только из
 * истории выкаток: запустить через панель можно лишь то, что здесь уже
 * работало, а не любой тег или коммит — для произвольного есть GitHub.
 *
 * В журнал — до ответа, с тем, с какой версии и на какую: запуск выкатки
 * меняет работу у всех, и «кто откатил в среду» должно находиться сразу.
 */
opsMaintRoutes.post("/releases/rollback", requirePermission("ops.manage"), async (c) => {
  const { version } = await parseBody(c.req.raw, rollbackSchema);
  const view = await listReleases(200);
  const target = view.items.find((r) => r.version === version);
  if (!target) badRequest("err.releaseUnknown", { version });
  const current = view.items[0];
  if (current && current.version === version) badRequest("err.releaseIsCurrent", { version });
  const details = { from: current?.version ?? null, to: version };
  try {
    await dispatchDeploy(version, { token: env.githubDispatchToken, repo: await knownRepo() });
  } catch (error) {
    /*
     * Неудачный запуск — тоже строка журнала: попытка откатить систему
     * значима сама по себе, и «пробовал, GitHub не принял» должно быть
     * видно так же, как удавшееся. Отказ после записи не отменяет её:
     * ошибку обработчика Hono превращает в ответ внутри цепочки, и
     * транзакция запроса коммитится.
     */
    await audit(c, {
      action: "ops.release_rollback",
      outcome: "error",
      resourceType: "release",
      resourceId: target.id,
      details,
    });
    throw error;
  }
  await audit(c, { action: "ops.release_rollback", resourceType: "release", resourceId: target.id, details });
  return c.json({ ok: true, workflowUrl: view.workflowUrl }, 202);
});
