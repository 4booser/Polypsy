import { Hono, type Context } from "hono";
import { and, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  disableUserSchema,
  opsSessionQuery,
  opsUserListQuery,
  renderError,
  SUPERADMIN_RANK,
  roleRank,
  t,
  type OpsSession,
  type OpsSessionPage,
  type OpsUserPage,
  type OpsUserRow,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { permissionExceptions, refreshTokens, roles, staffRoles, users, type UserRow } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf, hashPassword } from "../lib/auth";
import {
  clinicalTraceOf,
  emptyTrace,
  generateTempPassword,
  holdsOf,
  holdsText,
  journalEntriesOf,
  liveTokenCondition,
  matchRegistry,
  otherActiveSuperadmins,
  sessionCountsOf,
} from "../lib/accounts";
import { conflict, forbidden, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { clearFailures } from "../lib/loginGuard";
import { currentRequestId } from "../lib/log";
import { sessionsSummary, usersSummary } from "../lib/peopleStats";
import { revokeAllFor, revokeFamily } from "../lib/refresh";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Техпанель: учётные записи и сессии (/api/ops/users, /api/ops/sessions).
 *
 * Решение заказчика 2026-09-26: «возможность посмотреть всех пользователей,
 * выдать кому-то доступ, удалить или создать акк и подобное». Заведение и
 * смена роли остались на своих маршрутах (POST /api/users, PATCH
 * /api/users/:id/role) — второй путь к тому же действию разошёлся бы с
 * первым. Здесь то, чего не было: весь реестр с состоянием каждой учётки,
 * выключение, отзыв сессий, сброс пароля и удаление того, что удалять можно.
 *
 * Всё под users.manage — тем же правом, что заведение людей: «вести учётные
 * записи» одна работа, а не пять. Каждое действие — строка журнала; чтение
 * реестра — тоже (user.list), как у прежнего списка.
 *
 * Над суперадминистратором действует только суперадминистратор. Без этого
 * правила заведующий с users.manage сбросил бы суперадмину пароль, получил
 * бы новый в ответе — и вошёл бы под ним: право вести учётки стало бы правом
 * взять любую, включая ту, что раздаёт права.
 *
 * Порядок подключения в app.ts важен: эти наборы стоят раньше /api/ops
 * наблюдаемости, у которой свой заслон по ops.read на весь префикс. Hono
 * собирает обработчики в порядке регистрации, и ответ отсюда уходит раньше,
 * чем до чужого заслона дойдёт очередь, — а без этого вкладку «Користувачі»
 * открывало бы не users.manage, а ops.read.
 */

export const opsUserRoutes = new Hono<AppEnv>();
export const opsSessionRoutes = new Hono<AppEnv>();

opsUserRoutes.use("*", requireAuth, requireStaff, requirePermission("users.manage"));
opsSessionRoutes.use("*", requireAuth, requireStaff, requirePermission("users.manage"));

/* ─────────── общее ─────────── */

async function targetOf(id: string): Promise<UserRow> {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!row) notFound("err.userNotFound");
  return row;
}

/** Над суперадминистратором — только суперадминистратор (см. заголовок файла) */
function guardSuperadminTarget(actor: User, target: Pick<UserRow, "role">): void {
  if (target.role === "superadmin" && actor.role !== "superadmin") forbidden("err.superadminOnly");
}

/**
 * Последний действующий суперадмин — раньше проверки «себя», а не после.
 *
 * Иначе правило было бы недостижимо: действует над суперадмином только
 * суперадмин, и если он не сам, значит, он и есть ещё один действующий. А
 * «себя» — ровно тот случай, когда суперадмин последний: запрет назван
 * причиной, которая важнее, — системой станет некому управлять.
 */
async function guardLastSuperadmin(target: Pick<UserRow, "id" | "role">): Promise<void> {
  if (target.role !== "superadmin") return;
  if ((await otherActiveSuperadmins(target.id)) === 0) conflict("err.lastSuperadmin");
}

/** Отказ ответом, а не исключением: исключение откатило бы вместе с запросом и запись журнала об отказе */
function refusal(c: Context<AppEnv>, body: Record<string, unknown>) {
  return c.json({ ...body, requestId: currentRequestId() }, 409);
}

/* ─────────── реестр ─────────── */

/**
 * Весь реестр: персонал и пациенты, с состоянием каждой учётки.
 *
 * Поиск и порядок — в приложении после расшифровки, как у списка пациентов:
 * ФИО шифровано, и искать его в SQL нечем. Реестр учреждения — тысячи
 * строк, не миллионы; расшифровать их дешевле, чем хранить имя открыто.
 *
 * Телефон — слепым индексом и только целым номером: «0501112233» находит
 * человека, «111-22» — нет. Частичный номер пришлось бы искать по
 * расшифрованным телефонам всего реестра, а наружу телефон здесь не отдаётся
 * вовсе — экрану учёток он не нужен, и расшифровывать восемь тысяч номеров
 * ради поиска по куску значило бы раскрывать их без нужды.
 *
 * Тяжёлое — след, сессии, роли — считается только для строк страницы.
 * След и число записей журнала читаются системной ролью: заведующему с
 * users.manage политики строк показали бы только прохождения его групп, и
 * «следа нет» означало бы «следа в моей зоне нет» — а удаление уносит
 * каскадом всё. Наружу уходят числа, не содержимое.
 */
opsUserRoutes.get("/", async (c) => {
  const lang = langOf(c);
  const { q, role, status, sort, page, per } = parseQuery(c, opsUserListQuery);

  /*
   * Отбор и порядок — одной функцией (matchRegistry) с «вибрати всіх у
   * відборі» массовых действий (routes/opsPeople.ts): выбор «всех в отборе»
   * обязан совпадать с тем, что человек видит в списке, строка в строку.
   */
  const { all, matched } = await matchRegistry({ q, role, status, sort }, lang);
  const emailOf = new Map(all.map((u) => [u.id, u.email]));

  const slice = matched.slice((page - 1) * per, page * per);
  const ids = slice.map((u) => u.id);

  /*
   * Системная роль — одним окном и ДО остальных запросов, не вперемешку с
   * ними: asSystem переключает роль всей транзакции запроса и возвращает её
   * в finally, и два окна, открытые параллельно, закрывали бы друг друга —
   * часть счёта ушла бы под ролью сотрудника и тихо недосчитала бы след.
   */
  const [traces, journal] = await asSystem(() => Promise.all([clinicalTraceOf(ids), journalEntriesOf(ids)]));
  const [sessions, roleRows, exceptionRows] = await Promise.all([
    sessionCountsOf(ids),
    ids.length
      ? db
          .select({ userId: staffRoles.userId, code: roles.code, title: roles.title })
          .from(staffRoles)
          .innerJoin(roles, eq(roles.id, staffRoles.roleId))
          .where(inArray(staffRoles.userId, ids))
      : Promise.resolve([]),
    ids.length
      ? db
          .select({ userId: permissionExceptions.userId, n: sql<number>`count(*)::int` })
          .from(permissionExceptions)
          .where(
            and(
              inArray(permissionExceptions.userId, ids),
              isNull(permissionExceptions.revokedAt),
              or(isNull(permissionExceptions.expiresAt), gt(permissionExceptions.expiresAt, new Date().toISOString())),
            ),
          )
          .groupBy(permissionExceptions.userId)
      : Promise.resolve([]),
  ]);

  const items: OpsUserRow[] = slice.map((u) => {
    const mine = roleRows.filter((r) => r.userId === u.id);
    return {
      id: u.id,
      email: u.email,
      fullName: u.fullName,
      role: u.role,
      anonymous: u.anonymous,
      roleTitles: mine.map((r) => t(r.title, lang)),
      ladderRank: u.role === "superadmin" ? SUPERADMIN_RANK : mine.reduce((top, r) => Math.max(top, roleRank(r.code)), 0),
      exceptions: Number(exceptionRows.find((e) => e.userId === u.id)?.n ?? 0),
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      disabledAt: u.disabledAt,
      disabledReason: u.disabledReason,
      disabledByEmail: u.disabledBy ? (emailOf.get(u.disabledBy) ?? null) : null,
      mustChangePassword: u.mustChangePassword,
      sessions: sessions.get(u.id) ?? 0,
      trace: traces.get(u.id) ?? emptyTrace(),
      journalEntries: journal.get(u.id) ?? 0,
    };
  });

  /*
   * Имя действия то же, что у прежнего списка учёток: «кто листал реестр»
   * отвечается одной выборкой по журналу, каким бы экраном ни листали. Текст
   * поиска в журнал не пишется — в нём бывают имя и номер телефона, — пишется
   * только факт отбора.
   */
  await audit(c, {
    action: "user.list",
    details: { ops: true, matched: matched.length, returned: items.length, searched: Boolean(q), role, status },
  });

  const body: OpsUserPage = { items, total: matched.length, page, per };
  return c.json(body);
});

/**
 * Сводка реестра для графиков над списком (волна 11, участок people): роли и
 * состояния, второй фактор у персонала, новые учётки по неделям, входы по
 * дням. Только числа; пациенты — через порог малых чисел (lib/peopleStats.ts).
 *
 * Под системной ролью: попытки входа и второй фактор политики строк
 * открывают одной системе, и без неё заведующий с users.manage видел бы
 * «заперто: 0» там, где заперто пятеро.
 *
 * В журнал — тем же user.list, что и чтение реестра: «кто смотрел на
 * реестр» остаётся одной выборкой, чем бы на него ни смотрели.
 */
opsUserRoutes.get("/summary", async (c) => {
  const summary = await asSystem(() => usersSummary());
  await audit(c, { action: "user.list", details: { ops: true, view: "summary" } });
  return c.json(summary);
});

/* ─────────── выключение ─────────── */

/**
 * Выключить учётку: вход, обмен токена и живые токены отказывают сразу.
 *
 * Все сессии отзываются тут же (revokeAllFor гасит семьи refresh и сдвигает
 * границу access-токенов), а middleware сверх того отказывает любому токену
 * выключенной учётки — даже выданному позже сдвига. Два замка, потому что
 * выключают ровно тогда, когда не доверяют тому, у кого сейчас в руках
 * сессия.
 */
opsUserRoutes.post("/:id/disable", async (c) => {
  const actor = c.get("user");
  const { reason } = await parseBody(c.req.raw, disableUserSchema);
  const row = await targetOf(c.req.param("id"));
  guardSuperadminTarget(actor, row);
  await guardLastSuperadmin(row);
  if (row.id === actor.id) forbidden("err.cannotDisableSelf");
  if (row.disabledAt) conflict("err.userAlreadyDisabled");

  const disabledAt = new Date().toISOString();
  await db.update(users).set({ disabledAt, disabledReason: reason, disabledBy: actor.id }).where(eq(users.id, row.id));
  const revokedTokens = await revokeAllFor(row.id);

  await audit(c, {
    action: "user.disable",
    resourceType: "user",
    resourceId: row.id,
    subjectUserId: row.id,
    details: { reason, role: row.role, revokedTokens },
  });
  return c.json({ ok: true, disabledAt });
});

/** Включить обратно. Сессий не возвращает: войти человек должен заново */
opsUserRoutes.post("/:id/enable", async (c) => {
  const actor = c.get("user");
  const row = await targetOf(c.req.param("id"));
  guardSuperadminTarget(actor, row);
  if (!row.disabledAt) conflict("err.userNotDisabled");

  await db
    .update(users)
    .set({ disabledAt: null, disabledReason: null, disabledBy: null })
    .where(eq(users.id, row.id));

  await audit(c, {
    action: "user.enable",
    resourceType: "user",
    resourceId: row.id,
    subjectUserId: row.id,
    // за что выключали — остаётся в журнале рядом с включением, а не только в строке выключения
    details: { previousReason: row.disabledReason, disabledAt: row.disabledAt },
  });
  return c.json({ ok: true });
});

/* ─────────── сессии и пароль ─────────── */

/** Завершить все сессии: семьи refresh гасятся, access-токены отсекаются сдвигом границы */
opsUserRoutes.post("/:id/revoke-sessions", async (c) => {
  const actor = c.get("user");
  const row = await targetOf(c.req.param("id"));
  guardSuperadminTarget(actor, row);

  const revokedTokens = await revokeAllFor(row.id);
  await audit(c, {
    action: "user.sessions_revoke",
    resourceType: "user",
    resourceId: row.id,
    subjectUserId: row.id,
    details: { revokedTokens },
  });
  return c.json({ ok: true, revokedTokens });
});

/**
 * Сброс пароля: новый временный — в ответе ОДИН раз.
 *
 * Пароль генерирует сервер, а не присылает экран: так он не проходит через
 * чьи-то руки до того, как попадёт в базу, и не бывает «Qwerty123» от
 * уставшего администратора. В журнал уходит факт сброса и число отозванных
 * токенов — пароль туда не попадает никогда, ни целиком, ни частью.
 *
 * Дальше: все сессии отозваны (кто бы ни держал старые — они кончились),
 * счётчик неудачных попыток входа очищен (сброс обычно и просят после
 * блокировки), а консоль при входе с этим паролем попросит сменить его
 * (must_change_password). Счётчик очищается системной ролью: таблица
 * попыток открыта одной системе (миграция 0075), и под ролью сотрудника
 * удаление молча не задело бы ни строки.
 *
 * Свой пароль так не сбрасывают: для этого есть смена с текущим паролем, и
 * обходить её через техпанель значило бы, что угнанной сессии достаточно,
 * чтобы забрать учётку насовсем.
 */
opsUserRoutes.post("/:id/reset-password", async (c) => {
  const actor = c.get("user");
  const row = await targetOf(c.req.param("id"));
  guardSuperadminTarget(actor, row);
  if (row.id === actor.id) forbidden("err.cannotResetOwnPassword");

  const password = generateTempPassword();
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(password), mustChangePassword: true })
    .where(eq(users.id, row.id));
  const revokedTokens = await revokeAllFor(row.id);
  await asSystem(() => clearFailures(row.email));

  await audit(c, {
    action: "user.password_reset",
    resourceType: "user",
    resourceId: row.id,
    subjectUserId: row.id,
    details: { revokedTokens, mustChangePassword: true },
  });

  // ответ с паролем не кэшируется нигде по дороге: ни прокси, ни браузером
  c.header("Cache-Control", "no-store");
  return c.json({ password, revokedTokens });
});

/* ─────────── удаление ─────────── */

/** Нарушение внешнего ключа: драйвер отдаёт код Postgres, drizzle — иногда в cause */
function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23503" || e?.cause?.code === "23503";
}

/**
 * Удаление — только учётки без следа.
 *
 * «Клинические данные не удаляются» (docs/ARCHITECTURE.md): половина ссылок
 * на людей каскадные, и удаление строки users унесло бы прохождения, случаи,
 * согласия и переписку живого человека. Поэтому сначала считается след, и
 * при любом ненулевом источнике — отказ 409 со списком, что держит, и
 * подсказкой выключить вместо удаления. Внешние ключи RESTRICT — последняя
 * защита, а не первая: сработав, они говорят «что-то держит», но не что.
 *
 * Журнал держит так же: учётка, от имени которой есть хоть одна запись, не
 * удаляется — actor_id входит в хэш строки, и обнулить его значило бы
 * порвать цепочку. На деле удаляется то, чем ни разу не пользовались:
 * заведённое по ошибке, с опечаткой в почте, дубль.
 *
 * Только суперадминистратору — так же решено политикой строк на users
 * (миграция 0075: удаляют суперадмин и система). Разреши маршрут это
 * заведующему с users.manage, база молча не удалила бы ни строки, а ответ
 * сказал бы «удалено».
 *
 * Отказ по следу — ответом, а не исключением: исключение откатило бы
 * транзакцию запроса вместе с записью журнала об отказе, а «кто пытался
 * удалить врача с двумя сотнями заключений» — ровно то, что журнал должен
 * помнить. Само удаление — во вложенной транзакции (точка сохранения):
 * сработавший внешний ключ откатывает её одну, и отказ ещё можно записать.
 */
opsUserRoutes.delete("/:id", async (c) => {
  const actor = c.get("user");
  const lang = langOf(c);
  if (actor.role !== "superadmin") forbidden("err.superadminOnly");
  const row = await targetOf(c.req.param("id"));
  await guardLastSuperadmin(row);
  if (row.id === actor.id) forbidden("err.cannotDeleteSelf");

  const [traces, journal] = await asSystem(() => Promise.all([clinicalTraceOf([row.id]), journalEntriesOf([row.id])]));
  const holds = holdsOf(traces.get(row.id) ?? emptyTrace(), journal.get(row.id) ?? 0);
  const base = { action: "user.delete", resourceType: "user", resourceId: row.id, subjectUserId: row.id } as const;

  if (holds.length) {
    await audit(c, { ...base, outcome: "denied", details: { reason: "has_trace", holds } });
    return refusal(c, { error: renderError("err.userHasTrace", lang, { details: holdsText(holds, lang) }), holds });
  }

  try {
    await db.transaction(async (tx) => {
      await tx.delete(users).where(eq(users.id, row.id));
    });
  } catch (err) {
    if (!isForeignKeyViolation(err)) throw err;
    await audit(c, { ...base, outcome: "denied", details: { reason: "foreign_key" } });
    return refusal(c, { error: renderError("err.userHeld", lang), holds: [] });
  }

  await audit(c, { ...base, details: { email: row.email, role: row.role } });
  return c.json({ ok: true });
});

/* ─────────── сессии ─────────── */

/**
 * Активные сессии: кто, с какого времени и когда в последний раз обновлял
 * токен.
 *
 * Сессия — семья refresh-токенов: вход рождает её, каждое обновление
 * выдаёт в ней новый токен. «Начата» — первый токен семьи, «последнее
 * использование» — выдача текущего. Устройства и адреса здесь нет: у
 * refresh-токена они не хранятся, а подбирать их по журналу входов значило
 * бы показывать догадку как факт.
 */
opsSessionRoutes.get("/", async (c) => {
  const { userId, q, page, per } = parseQuery(c, opsSessionQuery);

  const rows = await db
    .select({
      familyId: refreshTokens.familyId,
      userId: refreshTokens.userId,
      lastUsedAt: refreshTokens.createdAt,
      expiresAt: refreshTokens.expiresAt,
      startedAt: sql<string>`(select min(f.created_at) from refresh_tokens f where f.family_id = ${refreshTokens.familyId})`,
      email: users.email,
      role: users.role,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(refreshTokens)
    .innerJoin(users, eq(users.id, refreshTokens.userId))
    .where(and(liveTokenCondition(), userId ? eq(refreshTokens.userId, userId) : undefined))
    .orderBy(desc(refreshTokens.createdAt));

  /* живой токен в семье один по построению ротации; гонка могла бы дать два — берётся свежий */
  const seen = new Set<string>();
  const words = q.split(/\s+/).filter(Boolean);
  const sessions: OpsSession[] = [];
  for (const r of rows) {
    if (seen.has(r.familyId)) continue;
    seen.add(r.familyId);
    const fullName = fullNameOf(r);
    const hay = `${fullName} ${r.email}`.toLowerCase();
    if (words.length && !words.every((w) => hay.includes(w))) continue;
    sessions.push({
      id: r.familyId,
      userId: r.userId,
      fullName,
      email: r.email,
      role: r.role,
      startedAt: new Date(r.startedAt ?? r.lastUsedAt).toISOString(),
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
    });
  }

  const items = sessions.slice((page - 1) * per, page * per);
  await audit(c, {
    action: "session.list",
    subjectUserId: userId ?? null,
    details: { matched: sessions.length, returned: items.length, searched: Boolean(q) },
  });

  const body: OpsSessionPage = { items, total: sessions.length, page, per };
  return c.json(body);
});

/**
 * Сводка живых сессий для графиков (волна 11): по роли и по возрасту, у
 * персонала и у пациентов порознь. Клиента и устройства нет — см.
 * lib/peopleStats.ts, sessionsSummary.
 */
opsSessionRoutes.get("/summary", async (c) => {
  const summary = await asSystem(() => sessionsSummary());
  await audit(c, { action: "session.list", details: { view: "summary" } });
  return c.json(summary);
});

/** Завершить одну сессию — семью целиком; access-токены человека отсекаются сдвигом границы */
opsSessionRoutes.post("/:id/revoke", async (c) => {
  const actor = c.get("user");
  const familyId = c.req.param("id");

  const live = await db
    .select({ userId: refreshTokens.userId })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.familyId, familyId), liveTokenCondition()))
    .limit(1);
  if (!live[0]) notFound("err.sessionNotFound");
  const owner = await targetOf(live[0].userId);
  guardSuperadminTarget(actor, owner);

  await revokeFamily(familyId);
  await audit(c, {
    action: "session.revoke",
    resourceType: "session",
    resourceId: familyId,
    subjectUserId: owner.id,
  });
  return c.json({ ok: true });
});
