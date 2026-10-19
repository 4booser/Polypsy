import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { SUPERADMIN_RANK, roleRank, t, type Lang, type StaffAccount, type StaffPlacement } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import {
  departments,
  permissionExceptions,
  roles,
  specialistProfiles,
  staffRoles,
  userSecondFactor,
  users,
} from "../db/schema";

/**
 * Справочник сотрудников — то, что раздел «Лікарі» добавляет к строке учётной
 * записи. Общее у двух маршрутов, которые его отдают (GET /api/users и
 * GET /api/permissions/staff, оба с `?directory=1`): правило «откуда берётся
 * відділення» записано один раз, иначе оно разошлось бы между суперадмином и
 * заведующим, и один и тот же человек стоял бы у них в разных группах.
 *
 * Відділення — из профиля приёма (specialist_profiles → departments), а не из
 * users.unit. У сотрудника users.unit — поле анкеты, карточка подписывает его
 * «Організація» (учреждение = экземпляр системы), и набрано оно от руки; а
 * отделение профиля выбрано из справочника, то есть у двух людей одного
 * отделения оно пишется одинаково и группа не рассыпается на «Психологічне
 * відділення» и «психол. відділення». Анкетное поле остаётся запасным — его
 * подставляет экран (apps/web/src/pages/people/model.ts, workplaceOf), когда
 * профиля нет: так учреждение, не ведущее расписание приёма, не получает
 * список, где все «без відділення».
 */
export async function placementsOf(ids: string[], lang: Lang): Promise<Map<string, StaffPlacement>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ userId: specialistProfiles.userId, position: specialistProfiles.position, title: departments.title })
    .from(specialistProfiles)
    .innerJoin(departments, eq(departments.id, specialistProfiles.departmentId))
    .where(inArray(specialistProfiles.userId, ids));
  return new Map(
    rows.map((r) => [
      r.userId,
      /* пустая посада — не посада: «Психолог» и «» не должны стать двумя группами */
      { department: t(r.title as never, lang), position: r.position?.trim() || null },
    ]),
  );
}

/**
 * Учётная запись каждого сотрудника справочника — для реестра 2.0: вход,
 * второй фактор, состояние, роли-шаблоны, личные исключения и сколько
 * пациентов человек ведёт.
 *
 * Общее у двух маршрутов справочника, как и placementsOf: суперадмин и
 * заведующий видят одного человека одинаково. Всё — числа и отметки; о самих
 * пациентах наружу не уходит ничего. Число закреплённых считается системной
 * ролью (asSystem): под ролью сотрудника политики строк показали бы только
 * пациентов его зоны, и у коллеги из другого отделения выходил бы «0» —
 * неправда, которую реестр печатал бы как нагрузку.
 */
export async function accountsOf(
  rows: { id: string; role: string; lastSeenAt: string | null; disabledAt: string | null; mustChangePassword: boolean }[],
  lang: Lang,
): Promise<Map<string, StaffAccount>> {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return new Map();
  const now = new Date().toISOString();
  /*
   * Системной ролью — одним окном и до остальных запросов (см. asSystem в
   * opsAccounts.ts). Второй фактор — тоже: политика строк открывает человеку
   * только свою строку user_second_factor, а реестру нужен лишь факт «включён».
   */
  const [led, factors] = await asSystem(() =>
    Promise.all([
      db
        .select({ id: users.leadSpecialistId, n: sql<number>`count(*)::int` })
        .from(users)
        .where(and(eq(users.role, "user"), inArray(users.leadSpecialistId, ids), isNull(users.disabledAt)))
        .groupBy(users.leadSpecialistId),
      db
        .select({ id: userSecondFactor.userId })
        .from(userSecondFactor)
        .where(and(inArray(userSecondFactor.userId, ids), isNotNull(userSecondFactor.confirmedAt))),
    ]),
  );
  const [roleRows, exceptionRows] = await Promise.all([
    db
      .select({ userId: staffRoles.userId, code: roles.code, title: roles.title })
      .from(staffRoles)
      .innerJoin(roles, eq(roles.id, staffRoles.roleId))
      .where(inArray(staffRoles.userId, ids)),
    db
      .select({ userId: permissionExceptions.userId, n: sql<number>`count(*)::int` })
      .from(permissionExceptions)
      .where(
        and(
          inArray(permissionExceptions.userId, ids),
          isNull(permissionExceptions.revokedAt),
          or(isNull(permissionExceptions.expiresAt), gt(permissionExceptions.expiresAt, now)),
        ),
      )
      .groupBy(permissionExceptions.userId),
  ]);
  const withFactor = new Set(factors.map((f) => f.id));
  const patients = new Map(led.map((r) => [r.id, Number(r.n)]));
  const exceptions = new Map(exceptionRows.map((r) => [r.userId, Number(r.n)]));
  return new Map(
    rows.map((r): [string, StaffAccount] => {
      const mine = roleRows.filter((x) => x.userId === r.id);
      const ladderRank =
        r.role === "superadmin" ? SUPERADMIN_RANK : mine.reduce((top, x) => Math.max(top, roleRank(x.code)), 0);
      return [
        r.id,
        {
          lastSeenAt: r.lastSeenAt,
          mfa: withFactor.has(r.id),
          disabledAt: r.disabledAt,
          mustChangePassword: r.mustChangePassword,
          ladderRank,
          roles: mine.map((x) => ({ code: x.code, title: t(x.title as never, lang) })),
          exceptions: exceptions.get(r.id) ?? 0,
          patients: patients.get(r.id) ?? 0,
        },
      ];
    }),
  );
}
