import { Hono, type Context } from "hono";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ALL_PERMISSIONS,
  EXCEPTION_PERMISSIONS,
  PERMISSION_EFFECTS,
  PERMISSION_GROUPS,
  PERMISSION_TITLES,
  SUPERADMIN_RANK,
  canAssignRole,
  roleRank,
  type Permission,
} from "@quizzy/shared";
import { db } from "../db";
import { permissionExceptions, rolePermissions, roles, staffRoles, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf, toPublicUser } from "../lib/auth";
import { badRequest, forbidden, notFound, parseBody } from "../lib/http";
import { ladderRankOf, permissionsOf } from "../lib/permissions";
import { requireAuth, requireStaff, requireSuperadmin, type AppEnv } from "../middleware/auth";

/**
 * Управление правами.
 *
 * Закрыто суперадмином — кроме одного маршрута. Список того, кто что может, —
 * это карта доступа к клиническим данным, и раздавать её всему персоналу
 * незачем; но назначение ролей вниз по лестнице должностей делает не
 * технический администратор, а главный врач и заведующий отделением, и
 * закрытый им маршрут означал бы, что цепочки нет вовсе.
 *
 * Поэтому requireSuperadmin стоит на каждом маршруте отдельно, а не общей
 * строкой на всю группу. Общая строка выглядела бы надёжнее, но исключение
 * из неё всё равно потребовалось бы — а исключение из общего правила
 * незаметнее, чем отсутствие правила: маршрут без строки виден при чтении
 * файла сверху вниз, маршрут, вычтенный из «всех», — нет.
 *
 * Экран прав отвечает на два вопроса: «что этот человек может» и «почему».
 * Поэтому здесь отдаются не только итоговые права, но и то, из чего они
 * сложились: роли и личные исключения с причиной и сроком. Итог без
 * происхождения бесполезен — по нему нельзя решить, что менять.
 */
export const permissionRoutes = new Hono<AppEnv>();

permissionRoutes.use("*", requireAuth);

/**
 * Назначающий — тот, под кем на лестнице есть хоть одна ступень.
 *
 * Экран прав был закрыт суперадмином целиком, и цепочка назначения,
 * написанная в маршруте выдачи ролей, существовала только на бумаге:
 * заведующий отделением, которому она предназначена, до экрана не доходил —
 * первый же запрос отвечал «доступно только суперадминистратору», и весь
 * раздел оставался пустым.
 *
 * Ступень 1 (специалист) назначающим не считается: назначать строго ниже
 * себя ему некого, а справочник прав — это карта доступа к клиническим
 * данным, и раздавать её тем, кто ничего с ней сделать не может, незачем.
 */
async function assignerRank(c: Context<AppEnv>): Promise<number> {
  const rank = await ladderRankOf(c.get("user"));
  if (rank < 2) forbidden("err.notAnAssigner");
  return rank;
}

/**
 * Видна ли эта учётная запись назначающему.
 *
 * Одно правило на список людей, список исключений и карточку — чтобы «кого
 * я вижу» и «кого я вправе назначить» не разошлись. Разойдись они, экран
 * показывал бы людей, с которыми ничего сделать нельзя, или прятал тех, кого
 * назначать можно.
 */
function visibleTo(actorRank: number, targetRank: number, targetRole: string): boolean {
  if (actorRank >= SUPERADMIN_RANK) return true;
  if (targetRole === "superadmin") return false;
  return targetRank < actorRank;
}

/** Справочник: что вообще бывает. Отдаётся клиенту, чтобы экран не дублировал список. */
permissionRoutes.get("/catalogue", requireStaff, async (c) => {
  await assignerRank(c);
  return c.json({
    groups: PERMISSION_GROUPS.map((g) => ({
      code: g.code,
      title: g.title,
      permissions: g.permissions.map((p) => ({
        code: p,
        title: PERMISSION_TITLES[p],
        /*
         * Что право открывает на деле. Собирающему роль нужно не название
         * права, а ответ на вопрос «что человек увидит и сможет»: по одному
         * названию «Смотреть аналитику методик» не догадаться, что вместе с
         * ней открывается качество данных по каждому пункту.
         */
        effect: PERMISSION_EFFECTS[p],
      })),
    })),
    /* какие права осмысленно выдавать поштучно — экран показывает их быстрыми кнопками */
    exceptionable: EXCEPTION_PERMISSIONS,
  });
});

permissionRoutes.get("/roles", requireStaff, async (c) => {
  const rank = await assignerRank(c);
  const list = await db.select().from(roles).orderBy(roles.code);
  const perms = await db.select().from(rolePermissions);
  const counts = await db
    .select({ roleId: staffRoles.roleId, people: sql<number>`count(*)` })
    .from(staffRoles)
    .groupBy(staffRoles.roleId);
  const byRole = new Map(counts.map((r) => [r.roleId, Number(r.people)]));

  return c.json({
    items: list.map((r) => ({
      id: r.id,
      code: r.code,
      title: r.title,
      isBuiltin: r.isBuiltin,
      permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
      people: byRole.get(r.id) ?? 0,
      /*
       * Роли отдаются все, но с пометкой, а не фильтруются.
       *
       * Заведующий должен видеть, что над ним есть ступень главного врача, —
       * иначе экран рисует лестницу, обрывающуюся на нём, и «почему я не могу
       * этого назначить» превращается в вопрос без ответа. Пометка отвечает
       * на него на месте.
       */
      assignable: rank >= SUPERADMIN_RANK || canAssignRole(rank, r.code),
    })),
  });
});

const roleSchema = z.object({
  code: z.string().min(2).max(40),
  title: z.object({ uk: z.string().min(1), ru: z.string().min(1) }),
  permissions: z.array(z.string()),
});

permissionRoutes.post("/roles", requireSuperadmin, async (c) => {
  const input = await parseBody(c.req.raw, roleSchema);
  const unknown = input.permissions.filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
  if (unknown.length) badRequest("err.unknownPermission", { permission: unknown.join(", ") });

  const id = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(roles).values({ id, code: input.code, title: input.title });
    if (input.permissions.length) {
      await tx
        .insert(rolePermissions)
        .values(input.permissions.map((permission) => ({ roleId: id, permission })));
    }
  });
  await audit(c, { action: "role.create", resourceType: "role", resourceId: id, details: { code: input.code } });
  return c.json({ id }, 201);
});

permissionRoutes.put("/roles/:id/permissions", requireSuperadmin, async (c) => {
  const id = c.req.param("id");
  const [role] = await db.select().from(roles).where(eq(roles.id, id));
  if (!role) notFound("err.roleNotFound");
  /*
   * Встроенная роль не правится вручную: её набор задан справочником и
   * приводится к нему при каждом старте. Ручная правка молча откатилась бы
   * при следующем перезапуске — а человек считал бы, что права выданы.
   */
  if (role.isBuiltin) badRequest("err.builtinRoleReadOnly");

  const input = await parseBody(c.req.raw, z.object({ permissions: z.array(z.string()) }));
  const unknown = input.permissions.filter((p) => !ALL_PERMISSIONS.includes(p as Permission));
  if (unknown.length) badRequest("err.unknownPermission", { permission: unknown.join(", ") });

  await db.transaction(async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    if (input.permissions.length) {
      await tx.insert(rolePermissions).values(input.permissions.map((permission) => ({ roleId: id, permission })));
    }
  });
  await audit(c, {
    action: "role.update",
    resourceType: "role",
    resourceId: id,
    details: { permissions: input.permissions },
  });
  return c.json({ ok: true });
});

/** Что может конкретный человек и из чего это сложилось */
/**
 * Карточка доступа человека — и кому её видно.
 *
 * Открыта не только суперадмину, и без этого цепочка назначения не работает
 * в интерфейсе вовсе: главный врач, назначающий заведующего, обязан видеть,
 * что у того сейчас есть, — иначе он назначает вслепую и, заменяя набор
 * ролей целиком, снимает то, о чём не знал.
 *
 * Правило доступа то же, что у назначения, и это не совпадение, а условие:
 * два разных правила про одну лестницу однажды разойдутся, и разойдутся
 * молча. Читать можно карточку того, кто ступенью ниже, и свою собственную.
 * Смотреть снизу вверх нельзя: карта возможностей вышестоящего — это
 * подсказка, что именно у него отнять.
 */
/**
 * Кого я вправе назначать.
 *
 * Отдельный маршрут, а не `GET /api/users`: тот отвечает на другой вопрос —
 * «какие вообще есть учётные записи» — и открыт правом на управление ими.
 * Заведующему отделением нужен не список учёток, а список своих людей, и
 * выдавать ему ради этого управление учётными записями значило бы отдать
 * заодно заведение, блокировку и смену почты.
 */
permissionRoutes.get("/staff", requireStaff, async (c) => {
  const rank = await assignerRank(c);
  const rows = await db.select().from(users).where(ne(users.role, "user"));

  const items = [];
  for (const row of rows) {
    const person = toPublicUser(row);
    const theirRank = await ladderRankOf(person);
    if (!visibleTo(rank, theirRank, row.role)) continue;
    items.push({ id: row.id, email: row.email, role: row.role, fullName: fullNameOf(row as never) });
  }

  return c.json({ items });
});

permissionRoutes.get("/users/:id", requireStaff, async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (!row) notFound("err.userNotFound");

  if (actor.id !== id) {
    const mine = await ladderRankOf(actor);
    const theirs = await ladderRankOf(toPublicUser(row));
    if (mine < SUPERADMIN_RANK && theirs >= mine) forbidden("err.roleAboveYours");
  }

  const mine = await db
    .select({ roleId: staffRoles.roleId, code: roles.code, title: roles.title, isBuiltin: roles.isBuiltin })
    .from(staffRoles)
    .innerJoin(roles, eq(roles.id, staffRoles.roleId))
    .where(eq(staffRoles.userId, id));

  const exceptions = await db
    .select()
    .from(permissionExceptions)
    .where(eq(permissionExceptions.userId, id))
    .orderBy(permissionExceptions.grantedAt);

  return c.json({
    userId: id,
    fullName: fullNameOf(row),
    role: row.role,
    readOnly: row.readOnly,
    roles: mine,
    exceptions,
    /* итог — то, что реально проверяется на маршрутах */
    effective: [...(await permissionsOf({ id, role: row.role } as never))],
  });
});

/**
 * Роли человека — и цепочка назначения.
 *
 * Единственный маршрут этой группы, открытый не только суперадмину.
 * Технический суперадмин назначает главного врача, главный врач —
 * заведующего отделением, заведующий — специалиста. Каждый может назначить
 * только ступень ниже своей.
 *
 * Проверка стоит здесь, а не на экране, и это главное в маршруте. Спрятанная
 * кнопка — не ограничение, а подсказка: любой, у кого есть токен, отправляет
 * тот же PUT из консоли браузера, и лестница держится ровно до первого
 * человека, которому пришло в голову попробовать. Заведующий, назначивший
 * себя главным врачом, отличается от главного врача только строкой в журнале,
 * которую никто не читает, пока не поздно.
 *
 * Проверяется РАЗНИЦА, а не список назначаемых ролей. Маршрут заменяет набор
 * целиком, поэтому «назначить выше своей» — не единственный способ им
 * навредить: не проверив снятые роли, заведующий одним запросом со списком
 * `[]` разжаловал бы главного врача, формально не назначив никого.
 */
permissionRoutes.put("/users/:id/roles", requireStaff, async (c) => {
  const id = c.req.param("id");
  const actor = c.get("user");
  const input = await parseBody(c.req.raw, z.object({ roleIds: z.array(z.string()) }));

  const [target] = await db.select().from(users).where(eq(users.id, id));
  if (!target) notFound("err.userNotFound");

  const known = new Map((await db.select().from(roles)).map((r) => [r.id, r]));
  const unknown = input.roleIds.filter((roleId) => !known.has(roleId));
  if (unknown.length) notFound("err.roleNotFound");

  const before = await db
    .select({ roleId: staffRoles.roleId })
    .from(staffRoles)
    .where(eq(staffRoles.userId, id));
  const had = new Set(before.map((r) => r.roleId));
  const next = new Set(input.roleIds);

  /* назначенные и снятые: и то и другое — вмешательство в чужую должность */
  const touched = [...new Set([...had, ...next])].filter((roleId) => had.has(roleId) !== next.has(roleId));
  const rank = await ladderRankOf(actor);

  if (rank < SUPERADMIN_RANK) {
    /*
     * Суперадмин остаётся вне лестницы с обеих сторон: его роли ничего не
     * решают (справочник он обходит целиком), но правка их посторонним — это
     * попытка добраться до учётной записи, из которой чинят систему.
     */
    if (target.role === "superadmin") forbidden("err.superadminOnly");

    /*
     * Назначение и снятие проверяются разными правилами, и это не
     * недосмотр.
     *
     * Назначение поднимает человека — поэтому оно ограничено вдвойне: только
     * ступень лестницы и только ниже своей. Снятие не поднимает никого;
     * опасно оно другим — разжалованием старшего, и достаточно запретить
     * трогать ступень не ниже собственной.
     *
     * Симметричное правило «снимать можно только то, что можешь назначить»
     * выглядело бы стройнее и не работало бы вовсе: встроенная роль
     * «психолог» выдаётся каждому администратору при заведении и в лестницу
     * не входит, так что главный врач не смог бы назначить заведующего, не
     * сняв её, — то есть не смог бы назначить никого. Это уже ловилось
     * тестом цепочки.
     */
    for (const roleId of touched) {
      const role = known.get(roleId)!;
      if (next.has(roleId)) {
        if (roleRank(role.code) === 0) forbidden("err.roleNotInChain", { role: role.code });
        if (!canAssignRole(rank, role.code)) forbidden("err.roleAboveYours", { role: role.code });
      } else if (roleRank(role.code) >= rank) {
        forbidden("err.roleAboveYours", { role: role.code });
      }
    }

    /*
     * И ни одного права сверх собственных.
     *
     * Ступень лестницы задана кодом роли, а набор прав роли правится на этом
     * же экране: достаточно добавить заведующему users.manage — и главный
     * врач, назначая заведующего, раздаст право, которого у него самого нет.
     * Лестница при этом не нарушена ни на шаг, а доступ вырос. Сравнение с
     * собственным набором закрывает именно этот зазор между «ниже по
     * должности» и «меньше по возможностям».
     */
    const added = touched.filter((roleId) => next.has(roleId));
    if (added.length) {
      const mine = await permissionsOf(actor);
      const granted = await db
        .select()
        .from(rolePermissions)
        .where(inArray(rolePermissions.roleId, added));
      for (const row of granted) {
        if (!mine.has(row.permission as Permission)) {
          forbidden("err.roleGrantsMoreThanYours", { permission: row.permission });
        }
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx.delete(staffRoles).where(eq(staffRoles.userId, id));
    if (input.roleIds.length) {
      await tx
        .insert(staffRoles)
        .values(input.roleIds.map((roleId) => ({ userId: id, roleId, grantedBy: actor.id })));
    }
  });
  await audit(c, {
    action: "user.roles_change",
    resourceType: "user",
    resourceId: id,
    subjectUserId: id,
    /* коды, а не только идентификаторы: журнал читают глазами, а не джойнами */
    details: {
      roleIds: input.roleIds,
      added: [...next].filter((r) => !had.has(r)).map((r) => known.get(r)!.code),
      removed: [...had].filter((r) => !next.has(r)).map((r) => known.get(r)?.code ?? r),
    },
  });
  return c.json({ ok: true });
});

const exceptionSchema = z.object({
  permission: z.string(),
  mode: z.enum(["grant", "revoke"]),
  /*
   * Причина словами, не выбором из списка: список превращается в «выбрать
   * первое», а написанное читают. Через год именно по причине понятно, было
   * ли исключение осмысленным.
   */
  reason: z.string().min(10),
  /** Срок в днях; без него исключение бессрочное и видно в списке как бессрочное */
  days: z.number().int().positive().max(365).optional(),
});

permissionRoutes.post("/users/:id/exceptions", requireSuperadmin, async (c) => {
  const id = c.req.param("id");
  const input = await parseBody(c.req.raw, exceptionSchema);
  if (!ALL_PERMISSIONS.includes(input.permission as Permission)) {
    badRequest("err.unknownPermission", { permission: input.permission });
  }

  const exceptionId = crypto.randomUUID();
  await db.insert(permissionExceptions).values({
    id: exceptionId,
    userId: id,
    permission: input.permission,
    mode: input.mode,
    reason: input.reason.trim(),
    grantedBy: c.get("user").id,
    expiresAt: input.days
      ? new Date(Date.now() + input.days * 86_400_000).toISOString()
      : null,
  });
  await audit(c, {
    action: "permission.exception",
    resourceType: "user",
    resourceId: id,
    subjectUserId: id,
    details: { permission: input.permission, mode: input.mode, reason: input.reason, days: input.days ?? null },
  });
  return c.json({ id: exceptionId }, 201);
});

permissionRoutes.post("/exceptions/:id/revoke", requireSuperadmin, async (c) => {
  const id = c.req.param("id");
  const [row] = await db.select().from(permissionExceptions).where(eq(permissionExceptions.id, id));
  if (!row) notFound("err.exceptionNotFound");
  if (row.revokedAt) badRequest("err.exceptionAlreadyRevoked");

  await db
    .update(permissionExceptions)
    .set({ revokedAt: new Date().toISOString() })
    .where(eq(permissionExceptions.id, id));
  await audit(c, {
    action: "permission.exception_revoke",
    resourceType: "user",
    resourceId: row.userId,
    subjectUserId: row.userId,
    details: { permission: row.permission, mode: row.mode },
  });
  return c.json({ ok: true });
});

/** Действующие исключения по всем — их разбирают, значит их надо видеть списком */
permissionRoutes.get("/exceptions", requireStaff, async (c) => {
  const rank = await assignerRank(c);
  const rows = await db
    .select({
      exception: permissionExceptions,
      user: users,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(permissionExceptions)
    .innerJoin(users, eq(users.id, permissionExceptions.userId))
    .where(
      and(
        isNull(permissionExceptions.revokedAt),
        or(isNull(permissionExceptions.expiresAt), sql`${permissionExceptions.expiresAt} > now()`),
      ),
    )
    .orderBy(permissionExceptions.grantedAt);

  /*
   * Чужие исключения не показываются тому, кто не вправе их снять: список
   * действующих исключений — это перечень того, кому что открыли сверх роли,
   * и он читается как карта доступа к клиническим данным.
   */
  const visible = [];
  for (const r of rows) {
    const theirRank = await ladderRankOf(toPublicUser(r.user));
    if (!visibleTo(rank, theirRank, r.user.role)) continue;
    visible.push({ ...r.exception, userName: fullNameOf(r as never) });
  }

  return c.json({ items: visible });
});
