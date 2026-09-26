import { Hono, type Context } from "hono";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  bulkUsersSchema,
  canAssignRole,
  extendGrantSchema,
  impersonateSchema,
  importUsersSchema,
  mfaPolicySchema,
  opsUserIdsQuery,
  patientPickQuery,
  renderError,
  resolveFindingSchema,
  roleRank,
  suspiciousQuery,
  whoViewedQuery,
  type BulkResult,
  type ErrorKey,
  type ImportCreated,
  type ImportPreview,
  type MfaCoverageRow,
  type MfaPolicyView,
  type PatientPick,
  type Permission,
  type Role,
  type SuspiciousFinding,
  type SuspiciousPage,
  type SuspiciousRule,
  type TemporaryGrant,
  type TemporaryGrants,
  type WhoViewedReport,
} from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import {
  auditLog,
  permissionExceptions,
  rolePermissions,
  roles,
  staffRoles,
  suspiciousFindings,
  userSecondFactor,
  users,
  type UserRow,
} from "../db/schema";
import { generateTempPassword, matchRegistry, otherActiveSuperadmins } from "../lib/accounts";
import { audit } from "../lib/audit";
import { fullNameOf, hashPassword } from "../lib/auth";
import { decryptField, encryptPersonFields } from "../lib/crypto";
import { badRequest, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { endImpersonation, startImpersonation } from "../lib/impersonation";
import { currentRequestId } from "../lib/log";
import { bulkSkip, groupWhoViewed, roleFrom, validateImport, type BulkActor, type BulkRole, type BulkTarget } from "../lib/people";
import { ensureBuiltinRole, ladderRankOf, permissionsOf } from "../lib/permissions";
import { revokeAllFor } from "../lib/refresh";
import { readPolicy, removeFactor, writePolicy } from "../lib/secondFactor";
import { thresholdsOf } from "../lib/suspicious";
import { lastScan, ruleConfig, scanSuspicious } from "../lib/suspiciousWatch";
import { requireAuth, requirePermission, requireStaff, requireSuperadmin, type AppEnv } from "../middleware/auth";

/**
 * Техпанель → «Люди й безпека» (/api/ops/people): вход «от имени», второй
 * фактор, подозрительная активность, временные доступы, массовые действия,
 * импорт сотрудников и отчёт «хто переглядав».
 *
 * Решение заказчика 2026-09-26, пункты 16–21. Продолжение участка accounts
 * (routes/opsAccounts.ts): те же правила «кого можно трогать», те же
 * отказы, тот же журнал.
 *
 * Права — на каждом маршруте отдельно, а не общей строкой: у разделов разные
 * работы. Смотреть подозрительное и отчёт о пациенте — audit.read (это чтение
 * журнала другими словами); вести учётки пачкой и импортом — users.manage;
 * политика второго фактора — ops.manage («менять работу системы»). Самое
 * опасное — вход под другим человеком, сброс чужого второго фактора и
 * продление выданного доступа — только суперадмину, никаким правом не
 * выдаётся (так же решено для выдачи личных исключений в routes/permissions.ts).
 *
 * requireStaff на всём наборе — второй рубеж, как у наблюдаемости: право,
 * по ошибке выданное учётке пациента, раздела не откроет.
 *
 * Подключается в app.ts РАНЬШЕ /api/ops наблюдаемости — по той же причине,
 * что учётки и сессии: иначе её заслон ops.read встал бы перед этими
 * маршрутами, и отчёт «хто переглядав» открывало бы право смотреть логи.
 */
export const opsPeopleRoutes = new Hono<AppEnv>();

opsPeopleRoutes.use("*", requireAuth, requireStaff);

/**
 * Отказ ответом, а не исключением: исключение откатило бы транзакцию запроса
 * вместе со строкой журнала об отказе (см. routes/opsAccounts.ts, refusal).
 */
function refuse(c: Context<AppEnv>, status: 400 | 403 | 404 | 409, key: ErrorKey) {
  return c.json({ error: renderError(key, langOf(c)), requestId: currentRequestId() }, status);
}

async function nameMap(ids: readonly (string | null)[]): Promise<Map<string, UserRow>> {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!list.length) return new Map();
  const rows = await db.select().from(users).where(inArray(users.id, list));
  return new Map(rows.map((r) => [r.id, r]));
}

/* ═══════════ 16. Вход «от имени» ═══════════ */

/**
 * Выдать токен «от имени» — только суперадмину, с причиной, на полчаса.
 *
 * Отказы (себя, суперадмина, выключенного) пишутся в журнал: попытка
 * смотреть глазами другого суперадмина — ровно то, что стоит найти потом.
 * Токен в ответе один раз и не кэшируется по дороге.
 */
opsPeopleRoutes.post("/impersonate/:id", requireSuperadmin, async (c) => {
  const actor = c.get("user");
  const { reason } = await parseBody(c.req.raw, impersonateSchema);
  const targetId = c.req.param("id");
  const started = await startImpersonation(actor, targetId, reason);
  if (!started.ok) {
    await audit(c, {
      action: "impersonation.start",
      outcome: "denied",
      resourceType: "user",
      resourceId: targetId,
      subjectUserId: targetId,
      details: { reason, refused: started.error },
    });
    return refuse(c, started.error === "err.userNotFound" ? 404 : 403, started.error);
  }
  await audit(c, {
    action: "impersonation.start",
    resourceType: "impersonation",
    resourceId: started.start.sessionId,
    subjectUserId: started.start.subject.id,
    details: { reason, expiresAt: started.start.expiresAt, subjectEmail: started.start.subject.email },
  });
  c.header("Cache-Control", "no-store");
  return c.json(started.start, 201);
});

/**
 * Закончить — своим токеном, не токеном «от имени»: тот пишет только
 * читающие запросы. Сессия гасится сразу, и скопированный токен не
 * доживает свои полчаса.
 */
opsPeopleRoutes.post("/impersonate/:id/end", requireSuperadmin, async (c) => {
  const actor = c.get("user");
  const row = await endImpersonation(c.req.param("id"), actor.id);
  if (row) {
    await audit(c, {
      action: "impersonation.end",
      resourceType: "impersonation",
      resourceId: row.id,
      subjectUserId: row.subjectId,
      details: { startedAt: row.startedAt, minutes: Math.round((Date.now() - new Date(row.startedAt).getTime()) / 60_000) },
    });
  }
  return c.json({ ok: true, ended: Boolean(row) });
});

/* ═══════════ 17. Второй фактор: политика и сброс ═══════════ */

/**
 * Политика и покрытие: кому по ней нужен второй фактор и у кого он есть.
 *
 * Покрытие считается при любой политике, а не только включённой: включают
 * требование, глядя на то, сколько людей упрётся в настройку завтра утром.
 * Фактор читается системной ролью: строки второго фактора открыты только
 * своему владельцу (миграция 0094), а здесь нужен только факт «есть / нет».
 */
opsPeopleRoutes.get("/mfa", requirePermission("ops.manage"), async (c) => {
  const policy = await readPolicy();
  const staff = await db.select().from(users).where(ne(users.role, "user"));
  const coverage: MfaCoverageRow[] = [];
  for (const u of staff) {
    let because: MfaCoverageRow["because"] | null = null;
    if (u.role === "superadmin") because = "superadmin";
    else {
      const perms = await permissionsOf({ id: u.id, role: u.role } as never);
      if (perms.has("ops.read") || perms.has("ops.manage")) because = "ops";
    }
    if (!because) continue;
    coverage.push({
      id: u.id,
      email: u.email,
      fullName: fullNameOf(u),
      role: u.role,
      because,
      enabled: false,
      confirmedAt: null,
      disabled: Boolean(u.disabledAt),
    });
  }
  const factors = coverage.length
    ? await asSystem(() =>
        db
          .select({ userId: userSecondFactor.userId, confirmedAt: userSecondFactor.confirmedAt })
          .from(userSecondFactor)
          .where(and(inArray(userSecondFactor.userId, coverage.map((r) => r.id)), isNotNull(userSecondFactor.confirmedAt))),
      )
    : [];
  const confirmed = new Map(factors.map((f) => [f.userId, f.confirmedAt]));
  for (const r of coverage) {
    r.confirmedAt = confirmed.get(r.id) ?? null;
    r.enabled = r.confirmedAt !== null;
  }
  coverage.sort((a, b) => Number(a.enabled) - Number(b.enabled) || a.fullName.localeCompare(b.fullName, langOf(c)));
  const author = policy.updatedById ? await db.query.users.findFirst({ where: eq(users.id, policy.updatedById) }) : null;
  const body: MfaPolicyView = {
    policy: { superadmins: policy.superadmins, ops: policy.ops, updatedAt: policy.updatedAt, updatedByEmail: author?.email ?? null },
    coverage,
  };
  return c.json(body);
});

/** Включить или снять требование — ops.manage, строка журнала «было → стало» */
opsPeopleRoutes.put("/mfa", requirePermission("ops.manage"), async (c) => {
  const actor = c.get("user");
  const input = await parseBody(c.req.raw, mfaPolicySchema);
  const before = await readPolicy();
  await writePolicy(input, actor.id);
  await audit(c, {
    action: "security.policy_update",
    resourceType: "security_policy",
    resourceId: "mfa",
    details: {
      mfaSuperadminsBefore: before.superadmins,
      mfaSuperadmins: input.superadmins,
      mfaOpsBefore: before.ops,
      mfaOps: input.ops,
    },
  });
  return c.json({ ok: true });
});

/**
 * Сбросить второй фактор другому — только суперадмин.
 *
 * Случай — потерянный телефон и израсходованные коды восстановления: человек
 * не может войти, и вернуть ему дверь может только тот, кто держит систему.
 * Сессии не трогаются — у человека их и нет (войти он не мог); если же сброс
 * просят из-за угона телефона, рядом стоит «Завершити всі сесії». Свой фактор
 * так не сбрасывают: для этого есть выключение паролем и кодом, и обходить
 * его через техпанель значило бы, что угнанной сессии суперадмина хватает,
 * чтобы снять с него второй замок.
 */
opsPeopleRoutes.post("/users/:id/mfa-reset", requireSuperadmin, async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");
  if (id === actor.id) return refuse(c, 403, "err.mfaResetOwn");
  const target = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!target) notFound("err.userNotFound");
  const removed = await asSystem(() => removeFactor(id));
  await audit(c, {
    action: "mfa.reset",
    resourceType: "user",
    resourceId: id,
    subjectUserId: id,
    details: { hadFactor: removed },
  });
  return c.json({ ok: true, hadFactor: removed });
});

/* ═══════════ 18. Подозрительная активность ═══════════ */

opsPeopleRoutes.get("/suspicious", requirePermission("audit.read"), async (c) => {
  const { status, rule, limit } = parseQuery(c, suspiciousQuery);
  const where = and(
    status === "open" ? isNull(suspiciousFindings.resolvedAt) : status === "resolved" ? isNotNull(suspiciousFindings.resolvedAt) : undefined,
    rule ? eq(suspiciousFindings.rule, rule) : undefined,
  );
  const [rows, [counts]] = await Promise.all([
    db.select().from(suspiciousFindings).where(where).orderBy(desc(suspiciousFindings.windowTo)).limit(limit),
    db
      .select({
        total: sql<number>`count(*)::int`,
        open: sql<number>`count(*) filter (where ${suspiciousFindings.resolvedAt} is null)::int`,
      })
      .from(suspiciousFindings)
      .where(rule ? eq(suspiciousFindings.rule, rule) : undefined),
  ]);
  const people = await nameMap(rows.flatMap((r) => [r.actorId, r.subjectId, r.resolvedBy]));
  const items: SuspiciousFinding[] = rows.map((r) => ({
    id: r.id,
    rule: r.rule as SuspiciousRule,
    actorId: r.actorId,
    actorEmail: r.actorEmail ?? (r.actorId ? (people.get(r.actorId)?.email ?? null) : null),
    actorName: r.actorId && people.get(r.actorId) ? fullNameOf(people.get(r.actorId)!) : null,
    subjectId: r.subjectId,
    subjectName: r.subjectId && people.get(r.subjectId) ? fullNameOf(people.get(r.subjectId)!) : null,
    ip: r.ip,
    windowFrom: r.windowFrom,
    windowTo: r.windowTo,
    hits: r.hits,
    details: r.details ?? null,
    detectedAt: r.detectedAt,
    notified: r.notifiedAt !== null,
    resolvedAt: r.resolvedAt,
    resolvedByEmail: r.resolvedBy ? (people.get(r.resolvedBy)?.email ?? null) : null,
    resolution: r.resolution,
  }));
  await audit(c, { action: "suspicious.read", details: { status, rule: rule ?? null, returned: items.length } });
  const body: SuspiciousPage = {
    items,
    total: Number(counts?.total ?? 0),
    open: Number(counts?.open ?? 0),
    lastScanAt: lastScan(),
    thresholds: thresholdsOf(await ruleConfig()),
  };
  return c.json(body);
});

/** «Розібрано» — с комментарием; кто и когда — в строке и в журнале */
opsPeopleRoutes.post("/suspicious/:id/resolve", requirePermission("audit.read"), async (c) => {
  const actor = c.get("user");
  const { comment } = await parseBody(c.req.raw, resolveFindingSchema);
  const id = c.req.param("id");
  const [row] = await db
    .update(suspiciousFindings)
    .set({ resolvedAt: new Date().toISOString(), resolvedBy: actor.id, resolution: comment })
    .where(and(eq(suspiciousFindings.id, id), isNull(suspiciousFindings.resolvedAt)))
    .returning();
  if (!row) {
    const exists = await db.query.suspiciousFindings.findFirst({ where: eq(suspiciousFindings.id, id) });
    return refuse(c, exists ? 409 : 404, exists ? "err.findingResolved" : "err.findingNotFound");
  }
  await audit(c, {
    action: "suspicious.resolve",
    resourceType: "suspicious_finding",
    resourceId: id,
    subjectUserId: row.actorId,
    details: { rule: row.rule, comment },
  });
  return c.json({ ok: true });
});

/**
 * Проверить сейчас, не дожидаясь такта. Та же функция, что у задачи по
 * расписанию; своим соединением (systemContext), поэтому видит журнал до
 * этого запроса, а не его собственные незакоммиченные строки.
 */
opsPeopleRoutes.post("/suspicious/scan", requirePermission("audit.read"), async (c) => {
  const result = await scanSuspicious();
  await audit(c, { action: "suspicious.scan", details: result });
  return c.json(result);
});

/* ═══════════ 19. Временные доступы ═══════════ */

const EXPIRED_DAYS = 30;

opsPeopleRoutes.get("/grants", requirePermission("users.manage"), async (c) => {
  const now = new Date().toISOString();
  const since = new Date(Date.now() - EXPIRED_DAYS * 86_400_000).toISOString();
  const rows = await db
    .select()
    .from(permissionExceptions)
    .where(
      or(
        and(isNull(permissionExceptions.revokedAt), isNotNull(permissionExceptions.expiresAt), gt(permissionExceptions.expiresAt, since)),
        and(isNull(permissionExceptions.revokedAt), isNull(permissionExceptions.expiresAt)),
      ),
    )
    .orderBy(asc(permissionExceptions.expiresAt));
  const people = await nameMap(rows.flatMap((r) => [r.userId, r.grantedBy]));
  const toGrant = (r: (typeof rows)[number]): TemporaryGrant => {
    const u = people.get(r.userId);
    return {
      id: r.id,
      userId: r.userId,
      userName: u ? fullNameOf(u) : "",
      userEmail: u?.email ?? "",
      permission: r.permission,
      mode: r.mode,
      reason: r.reason,
      grantedAt: r.grantedAt,
      grantedByEmail: people.get(r.grantedBy)?.email ?? null,
      expiresAt: r.expiresAt!,
      revokedAt: r.revokedAt,
    };
  };
  const dated = rows.filter((r) => r.expiresAt);
  const body: TemporaryGrants = {
    active: dated.filter((r) => r.expiresAt! > now).map(toGrant),
    expired: dated
      .filter((r) => r.expiresAt! <= now)
      .map(toGrant)
      .reverse(),
    permanent: rows.filter((r) => !r.expiresAt).length,
  };
  await audit(c, {
    action: "permission.exception_list",
    details: { active: body.active.length, expired: body.expired.length, permanent: body.permanent },
  });
  return c.json(body);
});

/**
 * Продлить — только суперадмину, как и выдать (routes/permissions.ts:
 * исключения заводит суперадмин). Продление — это выдача на новый срок, и
 * отдать его праву «вести учётки» значило бы, что заведующий продлевает
 * доступ, который сам выдать не может.
 *
 * Срок считается от нынешнего окончания, если оно впереди, и от сегодня,
 * если доступ уже истёк: «продовжити на 14 днів» истёкшему вчера — это две
 * недели с сегодняшнего дня, а не тринадцать. Отозванное не продлевается:
 * отзыв — решение, и отменять его продлением нельзя.
 */
opsPeopleRoutes.post("/grants/:id/extend", requireSuperadmin, async (c) => {
  const { days } = await parseBody(c.req.raw, extendGrantSchema);
  const id = c.req.param("id");
  const row = await db.query.permissionExceptions.findFirst({ where: eq(permissionExceptions.id, id) });
  if (!row) notFound("err.exceptionNotFound");
  if (row.revokedAt) badRequest("err.exceptionAlreadyRevoked");
  if (!row.expiresAt) badRequest("err.exceptionPermanent");
  const base = Math.max(Date.now(), new Date(row.expiresAt).getTime());
  const expiresAt = new Date(base + days * 86_400_000).toISOString();
  await db.update(permissionExceptions).set({ expiresAt }).where(eq(permissionExceptions.id, id));
  await audit(c, {
    action: "permission.exception_extend",
    resourceType: "user",
    resourceId: row.userId,
    subjectUserId: row.userId,
    details: { exceptionId: id, permission: row.permission, mode: row.mode, from: row.expiresAt, to: expiresAt, days },
  });
  return c.json({ ok: true, expiresAt });
});

/* ═══════════ 20. Массовые действия и импорт ═══════════ */

/** Весь отбор «Користувачів» идентификаторами — для «вибрати всіх у відборі» */
opsPeopleRoutes.get("/users/ids", requirePermission("users.manage"), async (c) => {
  const query = parseQuery(c, opsUserIdsQuery);
  const { matched } = await matchRegistry(query, langOf(c));
  await audit(c, {
    action: "user.list",
    details: { ops: true, idsOnly: true, matched: matched.length, searched: Boolean(query.q), role: query.role, status: query.status },
  });
  return c.json({ ids: matched.map((u) => u.id), total: matched.length });
});

/**
 * Массовое действие: выключить, включить, завершить сессии, назначить
 * роль-шаблон.
 *
 * Правила одиночных действий — на каждой строке (lib/people.ts, bulkSkip):
 * нельзя себя, над суперадмином — только суперадмин, последнего действующего
 * суперадмина не выключить (под замком, и по ходу пачки: выключили одного —
 * второй мог стать последним). Строка, не прошедшая правило, не валит пачку,
 * а попадает в «пропущено» с причиной: человек видит «зроблено 38, пропущено
 * 2 — себе не можна, останній суперадмін», а не одну ошибку на всё.
 *
 * Журнал — дважды, как у рассылки: сводкой (user.bulk, с числами и номером
 * пачки) и каждой учёткой своим действием (user.disable, …) с тем же номером
 * в details. Сводка не даёт массовому действию раствориться среди обычных,
 * поимённые строки отвечают на «кто и когда выключил этого человека».
 */
opsPeopleRoutes.post("/users/bulk", requirePermission("users.manage"), async (c) => {
  const input = await parseBody(c.req.raw, bulkUsersSchema);
  const me = c.get("user");
  const bulk = crypto.randomUUID();
  const ids = [...new Set(input.ids)];

  const actor: BulkActor = {
    id: me.id,
    role: me.role,
    rank: await ladderRankOf(me),
    perms: await permissionsOf(me),
  };
  let role: BulkRole | null = null;
  if (input.action === "assign-role") {
    const found = await db.query.roles.findFirst({ where: eq(roles.id, input.roleId) });
    if (!found) notFound("err.roleNotFound");
    const perms = await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, found.id));
    role = { id: found.id, code: found.code, permissions: perms.map((p) => p.permission) };
    /* назначает роли тот, у кого есть кому назначать, — как на экране прав (assignerRank) */
    if (me.role !== "superadmin" && actor.rank < 2) {
      await audit(c, { action: "user.bulk", outcome: "denied", details: { bulk, action: input.action, reason: "not_an_assigner" } });
      return refuse(c, 403, "err.notAnAssigner");
    }
  }

  const targets = await db.select().from(users).where(inArray(users.id, ids));
  const byId = new Map(targets.map((t) => [t.id, t]));
  const held = ids.length
    ? await db
        .select({ userId: staffRoles.userId, code: roles.code })
        .from(staffRoles)
        .innerJoin(roles, eq(roles.id, staffRoles.roleId))
        .where(inArray(staffRoles.userId, ids))
    : [];

  const result: BulkResult = { action: input.action, done: [], skipped: [] };
  for (const id of ids) {
    const row = byId.get(id) ?? null;
    const target: BulkTarget | null = row
      ? { id: row.id, role: row.role, disabledAt: row.disabledAt, roleCodes: held.filter((h) => h.userId === id).map((h) => h.code) }
      : null;
    let reason = bulkSkip(input.action, actor, target, role);
    if (!reason && input.action === "disable" && row!.role === "superadmin" && (await otherActiveSuperadmins(row!.id)) === 0) {
      reason = "lastSuperadmin";
    }
    if (reason) {
      result.skipped.push({ id, email: row?.email ?? null, reason });
      continue;
    }
    const base = { resourceType: "user", resourceId: id, subjectUserId: id } as const;
    switch (input.action) {
      case "disable": {
        await db
          .update(users)
          .set({ disabledAt: new Date().toISOString(), disabledReason: input.reason, disabledBy: me.id })
          .where(eq(users.id, id));
        const revokedTokens = await revokeAllFor(id);
        await audit(c, { action: "user.disable", ...base, details: { reason: input.reason, role: row!.role, revokedTokens, bulk } });
        break;
      }
      case "enable":
        await db.update(users).set({ disabledAt: null, disabledReason: null, disabledBy: null }).where(eq(users.id, id));
        await audit(c, { action: "user.enable", ...base, details: { previousReason: row!.disabledReason, disabledAt: row!.disabledAt, bulk } });
        break;
      case "revoke-sessions": {
        const revokedTokens = await revokeAllFor(id);
        await audit(c, { action: "user.sessions_revoke", ...base, details: { revokedTokens, bulk } });
        break;
      }
      case "assign-role":
        await db.insert(staffRoles).values({ userId: id, roleId: role!.id, grantedBy: me.id }).onConflictDoNothing();
        await audit(c, { action: "user.roles_change", ...base, details: { added: [role!.code], removed: [], bulk } });
        break;
    }
    result.done.push({ id, email: row!.email });
  }

  await audit(c, {
    action: "user.bulk",
    details: {
      bulk,
      action: input.action,
      requested: ids.length,
      done: result.done.length,
      skipped: result.skipped.length,
      ...(input.action === "disable" ? { reason: input.reason } : {}),
      ...(role ? { role: role.code } : {}),
    },
  });
  return c.json(result);
});

const IMPORT_MAX_ROWS = 200;

/**
 * Что знает импорт о базе: занятые почты и роли-шаблоны с «вправе ли
 * импортирующий её выдать» — по тем же правилам, что назначение на экране
 * прав: суперадмину — любую, остальным — ступень лестницы ниже своей и без
 * прав сверх собственных.
 */
async function importContext(me: AppEnv["Variables"]["user"], emails: string[]) {
  const taken = emails.length
    ? await db.select({ email: users.email }).from(users).where(inArray(users.email, emails))
    : [];
  const allRoles = await db.select().from(roles);
  const perms = await db.select().from(rolePermissions);
  const isSuper = me.role === "superadmin";
  const myRank = isSuper ? 0 : await ladderRankOf(me);
  const mine = isSuper ? null : await permissionsOf(me);
  const templates = new Map<string, { allowed: boolean; id: string }>();
  for (const r of allRoles) {
    const granted = perms.filter((p) => p.roleId === r.id).map((p) => p.permission);
    const allowed =
      isSuper ||
      (roleRank(r.code) > 0 && canAssignRole(myRank, r.code) && granted.every((p) => mine!.has(p as Permission)));
    templates.set(r.code, { allowed, id: r.id });
  }
  return { takenEmails: new Set(taken.map((t) => t.email.toLowerCase())), templates, actorIsSuper: isSuper };
}

function emailsIn(csv: string): string[] {
  /* грубо — все похожие на почту слова; точный разбор сделает validateImport */
  return [...new Set((csv.match(/[^\s,;"\t]+@[^\s,;"\t]+/g) ?? []).map((e) => e.toLowerCase()))];
}

opsPeopleRoutes.post("/users/import/preview", requirePermission("users.manage"), async (c) => {
  const { csv } = await parseBody(c.req.raw, importUsersSchema);
  const ctx = await importContext(c.get("user"), emailsIn(csv));
  const { rows, unknownColumns, missingColumns } = validateImport(csv, ctx);
  if (rows.length > IMPORT_MAX_ROWS) badRequest("err.importTooMany", { max: IMPORT_MAX_ROWS });
  const body: ImportPreview = { rows, valid: rows.filter((r) => !r.errors.length).length, unknownColumns, missingColumns };
  return c.json(body);
});

/**
 * Импорт пачкой — всё или ничего.
 *
 * Файл проверяется заново (между предпросмотром и нажатием кто-то мог
 * завести ту же почту), и при единой ошибке не создаётся никто: половина
 * отделения в системе и половина нет — хуже, чем «поправьте строку 17 и
 * загрузите снова». Создание — во вложенной транзакции: упавшая вставка
 * (гонка за почтой) откатывает всю пачку, а не оставляет её половину.
 *
 * Пароли — временные, сгенерированные сервером (как сброс пароля в
 * «Користувачах»), с must_change_password: их видит тот, кто импортирует,
 * один раз — в этом ответе; в журнал пароль не попадает никогда.
 */
opsPeopleRoutes.post("/users/import", requirePermission("users.manage"), async (c) => {
  const me = c.get("user");
  const { csv } = await parseBody(c.req.raw, importUsersSchema);
  const ctx = await importContext(me, emailsIn(csv));
  const { rows, unknownColumns, missingColumns } = validateImport(csv, ctx);
  if (rows.length > IMPORT_MAX_ROWS) badRequest("err.importTooMany", { max: IMPORT_MAX_ROWS });
  const valid = rows.filter((r) => !r.errors.length).length;
  if (!rows.length || valid !== rows.length || missingColumns.length) {
    await audit(c, {
      action: "user.import",
      outcome: "denied",
      details: { rows: rows.length, invalid: rows.length - valid, missingColumns },
    });
    const preview: ImportPreview = { rows, valid, unknownColumns, missingColumns };
    return c.json({ error: renderError("err.importInvalid", langOf(c)), requestId: currentRequestId(), preview }, 400);
  }

  const prepared = await Promise.all(
    rows.map(async (r) => {
      const password = generateTempPassword();
      return { r, password, hash: await hashPassword(password) };
    }),
  );
  const created: ImportCreated["created"] = [];
  await db.transaction(async (tx) => {
    for (const { r, password, hash } of prepared) {
      const role = roleFrom(r.role) as Exclude<Role, "user">;
      const [row] = await tx
        .insert(users)
        .values({
          id: crypto.randomUUID(),
          email: r.email,
          ...encryptPersonFields({ firstName: r.firstName, lastName: r.lastName, middleName: r.middleName || null }),
          passwordHash: hash,
          role,
          position: r.position || null,
          unit: r.unit || null,
          mustChangePassword: true,
        })
        .returning();
      created.push({ id: row!.id, email: row!.email, fullName: fullNameOf(row!), role, password });
    }
  });

  /* роли и журнал — после пачки: встроенная роль и шаблон выдаются так же, как при одиночном заведении */
  const bulk = crypto.randomUUID();
  for (const [i, person] of created.entries()) {
    const r = prepared[i]!.r;
    if (person.role === "admin") await ensureBuiltinRole(person.id);
    const tpl = r.roleTemplate ? ctx.templates.get(r.roleTemplate) : undefined;
    if (tpl) await db.insert(staffRoles).values({ userId: person.id, roleId: tpl.id, grantedBy: me.id }).onConflictDoNothing();
    await audit(c, {
      action: "user.create",
      resourceType: "user",
      resourceId: person.id,
      subjectUserId: person.id,
      details: { role: person.role, email: person.email, mustChangePassword: true, import: bulk, roleTemplate: r.roleTemplate || null },
    });
  }
  await audit(c, { action: "user.import", details: { import: bulk, created: created.length } });

  c.header("Cache-Control", "no-store");
  const body: ImportCreated = { created };
  return c.json(body, 201);
});

/* ═══════════ 21. Хто переглядав картку ═══════════ */

/**
 * Поиск пациента для отчёта — у проверяющего с audit.read может не быть
 * права видеть пациентов, а отчёт ему нужен. Отдаётся только то, чтобы
 * узнать человека: ФИО, почта, год рождения; не больше двадцати строк.
 * Поиск — в журнал (user.list), текст запроса — нет: в нём имя.
 */
opsPeopleRoutes.get("/patients", requirePermission("audit.read"), async (c) => {
  const { q } = parseQuery(c, patientPickQuery);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = await db.select().from(users).where(eq(users.role, "user"));
  const found: PatientPick[] = [];
  for (const u of all) {
    const name = fullNameOf(u);
    const hay = `${name} ${u.email}`.toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    const born = decryptField(u.birthDate);
    found.push({ id: u.id, fullName: name, email: u.email, birthYear: born ? born.slice(0, 4) : null });
    if (found.length >= 20) break;
  }
  await audit(c, { action: "user.list", details: { whoViewed: true, matched: found.length } });
  return c.json({ items: found });
});

/**
 * Отчёт «хто переглядав» — по запросу пациента или проверяющего.
 *
 * Все строки журнала, где пациент — субъект, и где под его именем смотрели
 * («от имени»), за период, кроме его собственных действий и строк без
 * человека (lib/people.ts, aboutPatient). Сгруппировано по сотруднику и дню
 * (день — по часам учреждения). Само формирование — строка журнала с
 * пациентом-субъектом: «кто запрашивал отчёт обо мне» — тоже про него.
 */
const WHO_VIEWED_MAX = 20_000;

opsPeopleRoutes.get("/who-viewed", requirePermission("audit.read"), async (c) => {
  const { patientId, from, to } = parseQuery(c, whoViewedQuery);
  if (to < from) badRequest("err.periodReversed");
  const patient = await db.query.users.findFirst({ where: eq(users.id, patientId) });
  if (!patient) notFound("err.userNotFound");

  const end = new Date(`${to}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 2); // запас на пояс учреждения; точная граница — ниже, по местному дню
  const start = new Date(`${from}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - 1);
  const rows = await db
    .select({
      at: auditLog.at,
      actorId: auditLog.actorId,
      actorEmail: auditLog.actorEmail,
      actorRole: auditLog.actorRole,
      action: auditLog.action,
      subjectUserId: auditLog.subjectUserId,
      details: auditLog.details,
    })
    .from(auditLog)
    .where(
      and(
        gte(auditLog.at, start.toISOString()),
        lt(auditLog.at, end.toISOString()),
        or(eq(auditLog.subjectUserId, patientId), sql`${auditLog.details}->>'asUserId' = ${patientId}`),
      ),
    )
    .orderBy(asc(auditLog.at))
    .limit(WHO_VIEWED_MAX);

  const { timezone } = await ruleConfig();
  const people = await nameMap(rows.map((r) => r.actorId));
  const names = new Map([...people].map(([id, u]) => [id, fullNameOf(u)]));
  const actors = groupWhoViewed(
    rows.map((r) => ({ ...r, details: r.details ?? null })),
    patientId,
    timezone,
    names,
  )
    .map((a) => ({ ...a, days: a.days.filter((d) => d.day >= from && d.day <= to) }))
    .map((a) => ({ ...a, total: a.days.reduce((s, d) => s + d.actions.reduce((x, y) => x + y.count, 0), 0) }))
    .filter((a) => a.total > 0);

  const report: WhoViewedReport = {
    patient: { id: patient.id, fullName: fullNameOf(patient), email: patient.email },
    from,
    to,
    total: actors.reduce((s, a) => s + a.total, 0),
    actors,
    generatedAt: new Date().toISOString(),
  };
  await audit(c, {
    action: "audit.subject_report",
    resourceType: "user",
    resourceId: patientId,
    subjectUserId: patientId,
    details: { from, to, entries: report.total, staff: actors.length },
  });
  return c.json(report);
});
