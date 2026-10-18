import { and, inArray, isNotNull, sql } from "drizzle-orm";
import type { MfaCoverageRow, OpsAttentionGroup, OpsAttentionPerson, OpsUserRow, OpsUsersAttention, Role } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { auditLog, userSecondFactor, users } from "../db/schema";
import { fullNameOf } from "./auth";
import { lockStates } from "./loginGuard";
import { permissionsOf } from "./permissions";
import { readPolicy } from "./secondFactor";

/*
 * «Користувачі» техпанели в Polypsy 2.0: второй фактор и запирание по
 * строке реестра и четыре группы «Потребує уваги».
 *
 * Правила здесь — те же, что у сторожа входа и политики второго фактора, а
 * не свои: «заперт» — lockStates (окно и порог isLockedOut), «обязателен
 * второй фактор» — политика readPolicy и права ops.* так же, как раздел
 * «Другий фактор» (GET /api/ops/people/mfa). Иначе строка реестра и раздел
 * назвали бы одного человека по-разному.
 *
 * Строки второго фактора и попыток входа открыты одной системе (миграции
 * 0075, 0094) — всё читается под asSystem; наружу уходят только «есть /
 * нет», число неудач и время.
 */

/** Временный пароль старше этого — повод напомнить: обычно его меняют в тот же день */
export const TEMP_PASSWORD_HOURS = 48;
/** Персонал без входа дольше этого — кандидат на выключение */
export const IDLE_STAFF_DAYS = 30;
/** Людей в группе для поповера; весь список — отбором реестра */
export const ATTENTION_PEOPLE = 12;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Because = MfaCoverageRow["because"];

/** По какой причине политика требует второй фактор от учётки; null — не требует */
async function requiredBecause(
  u: { id: string; role: Role },
  policy: { superadmins: boolean; ops: boolean },
): Promise<Because | null> {
  if (u.role === "user") return null;
  if (u.role === "superadmin") return policy.superadmins ? "superadmin" : null;
  if (!policy.ops) return null;
  const perms = await permissionsOf({ id: u.id, role: u.role } as never);
  return perms.has("ops.read") || perms.has("ops.manage") ? "ops" : null;
}

/** Учётки с подтверждённым вторым фактором — из переданных */
async function confirmedFactors(ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const rows = await asSystem(() =>
    db
      .select({ userId: userSecondFactor.userId })
      .from(userSecondFactor)
      .where(and(inArray(userSecondFactor.userId, [...ids]), isNotNull(userSecondFactor.confirmedAt))),
  );
  return new Set(rows.map((r) => r.userId));
}

/**
 * Второй фактор и запирание для строк страницы реестра. Пациентам второй
 * фактор — null: политика про персонал.
 */
export async function rowSecurityOf(
  rows: readonly { id: string; email: string; role: Role }[],
): Promise<Map<string, Pick<OpsUserRow, "secondFactor" | "lock">>> {
  const staff = rows.filter((r) => r.role !== "user");
  /*
   * По очереди, не Promise.all: asSystem переключает роль всей транзакции
   * запроса и возвращает её в finally — два окна вперемешку закрывали бы
   * друг друга (то же правило, что у списка реестра).
   */
  const policy = await readPolicy();
  const factors = await confirmedFactors(staff.map((r) => r.id));
  const locks = await asSystem(() => lockStates());
  const out = new Map<string, Pick<OpsUserRow, "secondFactor" | "lock">>();
  for (const r of rows) {
    const secondFactor =
      r.role === "user" ? null : { enabled: factors.has(r.id), required: await requiredBecause(r, policy) };
    out.set(r.id, { secondFactor, lock: locks.get(r.email.toLowerCase()) ?? null });
  }
  return out;
}

const group = (people: OpsAttentionPerson[]): OpsAttentionGroup => ({
  count: people.length,
  people: people.slice(0, ATTENTION_PEOPLE),
});

/** Учётка для «Потребує уваги»: имя уже собрано */
export interface AttentionAccount {
  id: string;
  email: string;
  role: Role;
  fullName: string;
  createdAt: string;
  lastSeenAt: string | null;
  disabledAt: string | null;
  mustChangePassword: boolean;
}

/** Всё, что разложению нужно знать, кроме самих учёток, — собранное заранее */
export interface AttentionFacts {
  now: number;
  /** Запертые адреса (нижний регистр) — lockStates */
  locks: ReadonlyMap<string, { failures: number; until: string }>;
  /** Учётки с подтверждённым вторым фактором */
  factors: ReadonlySet<string>;
  /** Почему политика требует второй фактор (только у кого требует) */
  because: ReadonlyMap<string, Because>;
  /** Когда выдан временный пароль — по журналу; нет — время заведения */
  issued: ReadonlyMap<string, string>;
}

/**
 * Разложение по четырём группам — без базы (test/opsUsersAttention.test.ts).
 * Выключенные учётки не входят ни в одну: дверь уже закрыта, и напоминать о
 * ней незачем.
 */
export function classifyAttention(accounts: readonly AttentionAccount[], f: AttentionFacts): OpsUsersAttention {
  const live = accounts.filter((u) => !u.disabledAt);
  const person = (u: AttentionAccount, at: string | null, extra?: Partial<OpsAttentionPerson>): OpsAttentionPerson => ({
    id: u.id,
    fullName: u.fullName,
    email: u.email,
    role: u.role,
    at,
    ...extra,
  });
  const byAt = (a: OpsAttentionPerson, b: OpsAttentionPerson) => (a.at ?? "").localeCompare(b.at ?? "");
  const age = (at: string) => f.now - new Date(at).getTime();

  /* заперты: раньше открывающиеся — первыми */
  const locked = live
    .filter((u) => f.locks.has(u.email.toLowerCase()))
    .map((u) => {
      const l = f.locks.get(u.email.toLowerCase())!;
      return person(u, l.until, { failures: l.failures });
    })
    .sort(byAt);

  /* второй фактор: обязателен, а не настроен */
  const mfaMissing = live
    .filter((u) => u.role !== "user" && f.because.has(u.id) && !f.factors.has(u.id))
    .map((u) => person(u, null, { because: f.because.get(u.id)! }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "uk"));

  /* временный пароль, выданный дольше TEMP_PASSWORD_HOURS назад: давние — первыми */
  const tempPassword = live
    .filter((u) => u.mustChangePassword)
    .map((u) => person(u, f.issued.get(u.id) ?? u.createdAt))
    .filter((p) => age(p.at!) > TEMP_PASSWORD_HOURS * HOUR_MS)
    .sort(byAt);

  /* персонал без входа дольше IDLE_STAFF_DAYS: давно не входившие — первыми */
  const idleStaff = live
    .filter((u) => u.role !== "user")
    .map((u) => person(u, u.lastSeenAt ?? u.createdAt, u.lastSeenAt ? {} : { never: true }))
    .filter((p) => age(p.at!) > IDLE_STAFF_DAYS * DAY_MS)
    .sort(byAt);

  return {
    locked: group(locked),
    mfaMissing: group(mfaMissing),
    tempPassword: group(tempPassword),
    idleStaff: group(idleStaff),
    tempHours: TEMP_PASSWORD_HOURS,
    idleDays: IDLE_STAFF_DAYS,
  };
}

/** Четыре группы «Потребує уваги» по всему реестру */
export async function usersAttention(now = Date.now()): Promise<OpsUsersAttention> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      createdAt: users.createdAt,
      lastSeenAt: users.lastSeenAt,
      disabledAt: users.disabledAt,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users);
  const accounts: AttentionAccount[] = rows.map((u) => ({
    id: u.id,
    email: u.email,
    role: u.role,
    fullName: fullNameOf(u),
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
    disabledAt: u.disabledAt,
    mustChangePassword: u.mustChangePassword,
  }));
  const live = accounts.filter((u) => !u.disabledAt);
  const staff = live.filter((u) => u.role !== "user");

  /* системные окна — по очереди (см. rowSecurityOf) */
  const locks = await asSystem(() => lockStates(now));
  const factors = await confirmedFactors(staff.map((u) => u.id));

  const policy = await readPolicy();
  const because = new Map<string, Because>();
  if (policy.superadmins || policy.ops) {
    for (const u of staff) {
      if (factors.has(u.id)) continue;
      const why = await requiredBecause(u, policy);
      if (why) because.set(u.id, why);
    }
  }

  /*
   * Временный пароль выдают заведение и сброс — время берётся из журнала
   * (последняя строка user.create или user.password_reset об этой учётке),
   * без неё — время заведения.
   */
  const temps = live.filter((u) => u.mustChangePassword).map((u) => u.id);
  const issued = new Map<string, string>();
  if (temps.length) {
    const marks = await asSystem(() =>
      db
        .select({ subject: auditLog.subjectUserId, at: sql<string>`max(${auditLog.at})` })
        .from(auditLog)
        .where(and(inArray(auditLog.action, ["user.create", "user.password_reset"]), inArray(auditLog.subjectUserId, temps)))
        .groupBy(auditLog.subjectUserId),
    );
    for (const m of marks) if (m.subject) issued.set(m.subject, new Date(m.at).toISOString());
  }

  return classifyAttention(accounts, { now, locks, factors, because, issued });
}
