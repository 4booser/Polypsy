import type { Context } from "hono";
import { eq } from "drizzle-orm";
import type { ErrorKey, ErrorParams, Permission, User } from "@quizzy/shared";
import { db } from "../db";
import { users, type UserRow } from "../db/schema";
import type { AppEnv } from "../middleware/auth";
import { otherActiveSuperadmins } from "./accounts";
import { accountRefusal, classGrantRefusal, standingFromRank, type AccountClass } from "./accountRule";
import { audit, type AuditAction } from "./audit";
import { conflict, forbidden, notFound } from "./http";
import { ensureBuiltinRole, hasPermission, ladderRankOf } from "./permissions";
import { revokeAllFor } from "./refresh";

export type { AccountClass } from "./accountRule";

/**
 * Действия над чужой учётной записью — одним правилом для всех входов.
 *
 * Внешний разбор 2026-09-27 (п. 1, P1): команда консоли `user role` меняла
 * класс, проверив только право users.manage. Сотрудник с console.use и
 * делегированным users.manage набирал `user role <своя почта> superadmin` и
 * со следующего же запроса работал суперадмином тем же токеном. HTTP-двойник
 * (PATCH /api/users/:id/role) держал «не себе» и «суперадмина — только
 * суперадмин», но лестницы должностей не знал вовсе, а консоль не знала и
 * этого: одно правило, записанное в обработчике, обходилось соседним входом.
 *
 * Решение заказчика 2026-09-28: та же дыра — в каждом действии над чужой
 * учёткой, а не только в смене класса. Сброс пароля главному врачу
 * заведующим с users.manage — захват учётки выше себя: временный пароль
 * приходит в ответе, и заведующий входит главным врачом. Поэтому все такие
 * действия — сброс пароля, выключение и включение, удаление, обрыв сессий,
 * сброс второго фактора, вход «от имени», роли и личные исключения, профиль
 * приёма, массовые действия, смена класса и «только чтения» — идут через
 * guardAccountAction, а правило живёт в lib/accountRule.ts:
 *  - нужно право действия — функция проверяет его сама, а не надеется на
 *    заслон входа;
 *  - не себе (своё меняют своими маршрутами; где действие над собой законно и
 *    другого пути к нему нет — свои сессии, своё устройство, — вызывающий
 *    говорит это явно: self: "allow");
 *  - суперадмина трогает только суперадмин;
 *  - цель строго ниже своего положения (пациент 0, сотрудник 1 + ступень
 *    лестницы, суперадмин выше всех).
 * Смена класса и заведение учётки сверх того выдают класс только ниже
 * своего положения (classGrantRefusal): сотрудник вне лестницы (встроенный
 * «психолог») стоит на 1 и, получив делегированный users.manage, сотрудников
 * не заводит — это выдача класса, равного своему.
 *
 * Проверка и запись — под одним замком строки (SELECT … FOR UPDATE в
 * транзакции запроса): иначе заведующий, прочитавший цель администратором,
 * разжаловал бы её уже после того, как суперадмин сделал её суперадмином.
 */

export const ACCOUNT_CLASSES = ["superadmin", "admin", "user"] as const;

export function isAccountClass(value: unknown): value is AccountClass {
  return typeof value === "string" && (ACCOUNT_CLASSES as readonly string[]).includes(value);
}

/** Откуда пришло действие — пометка журнала, а не ветка правила */
export type AccountEntry = "http" | "console";

/** Положение учётной записи (lib/accountRule.ts, standingFromRank) по её строке в базе */
export async function standingOf(person: { id: string; role: AccountClass }): Promise<number> {
  if (person.role !== "admin") return standingFromRank(person.role, 0);
  return standingFromRank("admin", await ladderRankOf(person as User));
}

const REFUSAL_KEYS: Record<"superadminOnly" | "aboveYours", ErrorKey> = {
  superadminOnly: "err.superadminOnly",
  aboveYours: "err.accountAtOrAboveYours",
};

export interface AccountActionOptions {
  /** Право действия; null — вход уже закрыт суперадмину (requireSuperadmin) или прав у действия нет вовсе */
  permission: Permission | null;
  /**
   * Действие над собой: ключ отказа (по умолчанию err.ownAccount) — или
   * "allow", если оно над собой законно и другого пути к нему нет.
   */
  self?: ErrorKey | "allow";
  /**
   * Действие журнала для строки отказа: попытка тронуть старшего должна быть
   * видна. null — отказ пишет сам вход (консоль пишет его строкой console.run).
   */
  action: AuditAction | null;
  /**
   * Последнего действующего суперадмина не трогать (выключение, удаление).
   * Проверяется раньше «себя»: суперадмин, выключающий себя последним,
   * должен услышать настоящую причину — системой станет некому управлять.
   */
  lastSuperadmin?: boolean;
  /** Запереть строку цели до конца транзакции (по умолчанию — да; чтению «от имени» замок не нужен) */
  lock?: boolean;
}

/**
 * Проверить, что вызывающий вправе действовать над этой учёткой, и вернуть
 * её строку (под замком). Отказ — 403 (последний суперадмин — 409) и строка
 * журнала с исходом denied; отказ журнала переживает откат запроса.
 */
export async function guardAccountAction(c: Context<AppEnv>, targetId: string, opts: AccountActionOptions): Promise<UserRow> {
  const actor = c.get("user");
  if (opts.permission && !(await hasPermission(actor, opts.permission))) {
    forbidden("err.permissionRequired", { permission: opts.permission });
  }

  const query = db.select().from(users).where(eq(users.id, targetId));
  const [target] = opts.lock === false ? await query : await query.for("update");
  if (!target) notFound("err.userNotFound");

  const deny = async (key: ErrorKey, status: 403 | 409 = 403, params?: ErrorParams): Promise<never> => {
    if (opts.action) {
      await audit(c, {
        action: opts.action,
        outcome: "denied",
        resourceType: "user",
        resourceId: target.id,
        subjectUserId: target.id,
        details: { reason: key, targetRole: target.role },
      });
    }
    return status === 409 ? conflict(key, params) : forbidden(key, params);
  };

  const reason = accountRefusal(
    { id: actor.id, role: actor.role, standing: await standingOf(actor) },
    { id: target.id, role: target.role, standing: await standingOf(target) },
  );
  if (
    opts.lastSuperadmin &&
    reason !== "superadminOnly" &&
    target.role === "superadmin" &&
    (await otherActiveSuperadmins(target.id)) === 0
  ) {
    await deny("err.lastSuperadmin", 409);
  }
  if (reason === "self") {
    if (opts.self !== "allow") await deny(opts.self ?? "err.ownAccount");
  } else if (reason) {
    await deny(REFUSAL_KEYS[reason]);
  }
  return target;
}

/**
 * Сменить класс учётной записи.
 *
 * Смена обрывает сессии человека (refresh гасится, граница access-токенов
 * сдвигается). Роль в токене не хранится как источник прав — requireAuth
 * читает строку пользователя на каждый запрос, — поэтому без обрыва открытая
 * вкладка молча получила бы новые права посреди работы, а разжалованный
 * дорабатывал бы в ней старым токеном до 401 по другой причине. Новый класс
 * человек получает новым входом.
 */
export async function changeAccountClass(
  c: Context<AppEnv>,
  targetId: string,
  next: unknown,
  via: AccountEntry,
): Promise<{ before: AccountClass; row: UserRow }> {
  const actor = c.get("user");
  if (!isAccountClass(next)) forbidden("err.invalidRole");

  const target = await guardAccountAction(c, targetId, {
    permission: "users.manage",
    self: "err.cannotChangeOwnRole",
    action: "user.role_change",
  });
  /* должность, оставшаяся у цели, вернётся вместе с классом — она и считается */
  const grant = classGrantRefusal(
    { role: actor.role, standing: await standingOf(actor) },
    next,
    next === "admin" ? await ladderRankOf({ id: target.id, role: "admin" } as User) : 0,
  );
  if (grant) {
    // отказ — в журнал: попытка раздать больше, чем положено, должна быть видна
    await audit(c, {
      action: "user.role_change",
      outcome: "denied",
      resourceType: "user",
      resourceId: target.id,
      subjectUserId: target.id,
      details: { newRole: next, currentRole: target.role, reason: grant, via },
    });
    if (grant === "superadminOnly") forbidden("err.superadminOnly");
    forbidden("err.roleAboveYours", { role: next });
  }
  // тот же класс — не смена: сессии человека обрывать не за что
  if (target.role === next) return { before: target.role, row: target };

  const [row] = await db.update(users).set({ role: next }).where(eq(users.id, target.id)).returning();
  // сотрудник получает встроенную роль сразу — как при заведении (routes/users.ts)
  if (next === "admin") await ensureBuiltinRole(target.id);
  await revokeAllFor(target.id);

  await audit(c, {
    action: "user.role_change",
    resourceType: "user",
    resourceId: target.id,
    subjectUserId: target.id,
    details: { newRole: next, previousRole: target.role, changedBy: actor.email, via },
  });
  return { before: target.role, row: row! };
}

/**
 * Можно ли завести учётную запись этого класса.
 *
 * Заведение — та же выдача класса, только новой учётке: завести сотрудника с
 * паролем, который сам же и придумал, значит получить сотрудника в руки.
 * Поэтому правило то же — строго ниже своего положения. У новой учётки
 * должности нет, и её положение — положение класса без лестницы.
 */
export async function assertMayCreateClass(c: Context<AppEnv>, next: AccountClass): Promise<void> {
  const actor = c.get("user");
  if (!(await hasPermission(actor, "users.manage"))) forbidden("err.permissionRequired", { permission: "users.manage" });
  const refusal = classGrantRefusal({ role: actor.role, standing: await standingOf(actor) }, next);
  if (!refusal) return;
  await audit(c, {
    action: "user.create",
    outcome: "denied",
    resourceType: "user",
    details: { role: next, reason: refusal },
  });
  if (refusal === "superadminOnly") forbidden("err.superadminOnly");
  forbidden("err.roleAboveYours", { role: next });
}

/**
 * «Только чтение» чужой учётке.
 *
 * HTTP-двойника у действия нет — оно есть только в консоли, — и тем важнее,
 * чтобы правило было то же, что у остальных действий над чужой учёткой:
 * запереть суперадмина в «только чтение» — значит отнять у системы того, кто
 * её чинит, а консоль (POST) ему после этого уже недоступна, и снять замок
 * сам он не сможет. Сессий не обрывает: «только чтение» читается из строки
 * пользователя на каждый запрос (middleware/auth.ts) и действует со
 * следующего же.
 */
export async function setAccountReadOnly(c: Context<AppEnv>, targetId: string, readOnly: boolean): Promise<UserRow> {
  // отказ пишет консоль (routes/console.ts) — своей строкой console.run с причиной
  const target = await guardAccountAction(c, targetId, { permission: "users.manage", action: null });
  const [row] = await db.update(users).set({ readOnly }).where(eq(users.id, target.id)).returning();
  return row!;
}
