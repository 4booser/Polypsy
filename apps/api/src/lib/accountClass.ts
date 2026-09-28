import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { SUPERADMIN_RANK, type ErrorKey, type ErrorParams, type User } from "@quizzy/shared";
import { db } from "../db";
import { users, type UserRow } from "../db/schema";
import type { AppEnv } from "../middleware/auth";
import { audit } from "./audit";
import { forbidden, notFound } from "./http";
import { ensureBuiltinRole, hasPermission, ladderRankOf } from "./permissions";
import { revokeAllFor } from "./refresh";

/**
 * Класс учётной записи (superadmin · admin · user) и «только чтение» — одним
 * правилом для всех входов.
 *
 * Внешний разбор 2026-09-27 (п. 1, P1): команда консоли `user role` меняла
 * класс, проверив только право users.manage. Сотрудник с console.use и
 * делегированным users.manage набирал `user role <своя почта> superadmin` и
 * со следующего же запроса работал суперадмином тем же токеном. HTTP-двойник
 * (PATCH /api/users/:id/role) держал «не себе» и «суперадмина — только
 * суперадмин», но лестницы должностей не знал вовсе, а консоль не знала и
 * этого: одно правило, записанное в обработчике, обходилось соседним входом.
 * Теперь правило живёт здесь, и маршрут и команда консоли только разбирают
 * ввод и зовут эти функции — проверки в них нельзя забыть, потому что их там
 * нет.
 *
 * Правило:
 *  - нужно право users.manage — функция проверяет его сама, а не надеется
 *    на заслон входа;
 *  - себе класс не меняют и себя в «только чтение» не переводят;
 *  - суперадмина трогает и назначает только суперадмин (защищённая учётка);
 *  - учётку на своей ступени или выше не трогают — как снятие ролей на
 *    экране прав (routes/permissions.ts): заведующий не разжалует главного
 *    врача в пациенты;
 *  - класс выдаётся только ниже собственного положения — «строго ниже», как
 *    canAssignRole у лестницы: равный назначает себе подобного, и лестница
 *    перестаёт быть лестницей на втором шаге.
 *
 * Положение (standingOf) — одна шкала для класса и лестницы: пациент 0,
 * сотрудник 1 + ступень должности, суперадмин выше всех. Сотрудник вне
 * лестницы (встроенный «психолог») стоит на 1 — и потому, получив
 * делегированный users.manage, сотрудников не заводит: это была бы выдача
 * класса, равного своему. Суперадмин стоит над всеми и действует над кем
 * угодно, кроме себя.
 *
 * Проверка и запись — под одним замком строки (SELECT … FOR UPDATE в
 * транзакции запроса): иначе заведующий, прочитавший цель администратором,
 * разжаловал бы её уже после того, как суперадмин сделал её суперадмином.
 */

export const ACCOUNT_CLASSES = ["superadmin", "admin", "user"] as const;
export type AccountClass = User["role"];

export function isAccountClass(value: unknown): value is AccountClass {
  return typeof value === "string" && (ACCOUNT_CLASSES as readonly string[]).includes(value);
}

/** Откуда пришло действие — пометка журнала, а не ветка правила */
export type AccountEntry = "http" | "console";

/**
 * Положение учётной записи на одной шкале с классом.
 *
 * Ступень лестницы считается и у пациента, если должность у него осталась
 * (класс её гасит, но не стирает): вернуть такого человека в сотрудники —
 * значит вернуть и должность, и решает это тот, кто выше неё.
 */
export async function standingOf(person: { id: string; role: AccountClass }): Promise<number> {
  if (person.role === "superadmin") return SUPERADMIN_RANK + 1;
  if (person.role === "user") return 0;
  return 1 + (await ladderRankOf(person as User));
}

interface Refusal {
  key: ErrorKey;
  params?: ErrorParams;
}

/** Почему нельзя — или null. Без записи в базу и журнал: одна логика на оба действия ниже */
async function refusalFor(actor: User, target: UserRow, next: AccountClass | null): Promise<Refusal | null> {
  if (target.id === actor.id) return { key: next ? "err.cannotChangeOwnRole" : "err.ownAccount" };
  if (actor.role === "superadmin") return null;
  if (target.role === "superadmin" || next === "superadmin") return { key: "err.superadminOnly" };

  const mine = await standingOf(actor);
  if ((await standingOf(target)) >= mine) return { key: "err.accountAtOrAboveYours" };
  if (next && (await standingOf({ id: target.id, role: next })) >= mine) {
    return { key: "err.roleAboveYours", params: { role: next } };
  }
  return null;
}

/** users.manage — проверкой здесь, а не только заслоном маршрута или реестром команд */
async function demandUsersManage(actor: User): Promise<void> {
  if (!(await hasPermission(actor, "users.manage"))) forbidden("err.permissionRequired", { permission: "users.manage" });
}

/** Строка цели под замком до конца транзакции запроса */
async function lockTarget(id: string): Promise<UserRow> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).for("update");
  if (!row) notFound("err.userNotFound");
  return row;
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
  await demandUsersManage(actor);

  const target = await lockTarget(targetId);
  const refusal = await refusalFor(actor, target, next);
  if (refusal) {
    // отказ — в журнал: попытка раздать себе больше, чем положено, должна быть видна
    await audit(c, {
      action: "user.role_change",
      outcome: "denied",
      resourceType: "user",
      resourceId: target.id,
      subjectUserId: target.id,
      details: { newRole: next, currentRole: target.role, reason: refusal.key, via },
    });
    forbidden(refusal.key, refusal.params);
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
  await demandUsersManage(actor);
  if (actor.role === "superadmin") return;

  const refusal: Refusal | null =
    next === "superadmin"
      ? { key: "err.superadminOnly" }
      : (next === "admin" ? 1 : 0) >= (await standingOf(actor))
        ? { key: "err.roleAboveYours", params: { role: next } }
        : null;
  if (!refusal) return;
  await audit(c, {
    action: "user.create",
    outcome: "denied",
    resourceType: "user",
    details: { role: next, reason: refusal.key },
  });
  forbidden(refusal.key, refusal.params);
}

/**
 * «Только чтение» чужой учётке.
 *
 * HTTP-двойника у действия нет — оно есть только в консоли, — и тем важнее,
 * чтобы правило было то же, что у смены класса: запереть суперадмина в
 * «только чтение» — значит отнять у системы того, кто её чинит, а консоль
 * (POST) ему после этого уже недоступна, и снять замок сам он не сможет.
 * Сессий не обрывает: «только чтение» читается из строки пользователя на
 * каждый запрос (middleware/auth.ts) и действует со следующего же.
 */
export async function setAccountReadOnly(c: Context<AppEnv>, targetId: string, readOnly: boolean): Promise<UserRow> {
  const actor = c.get("user");
  await demandUsersManage(actor);
  const target = await lockTarget(targetId);
  const refusal = await refusalFor(actor, target, null);
  if (refusal) forbidden(refusal.key, refusal.params);
  const [row] = await db.update(users).set({ readOnly }).where(eq(users.id, target.id)).returning();
  return row!;
}
