import { desc, eq, inArray } from "drizzle-orm";
import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  emptyAudience,
  featureFlagAudienceSchema,
  flagEnabledFor,
  isFeatureFlagKey,
  type FeatureFlagAudience,
  type FeatureFlagKey,
  type FeatureFlagUpdate,
  type FlagAudienceNames,
  type FlagChange,
  type FlagSubject,
  type OpsFlag,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import {
  departments,
  featureFlagChanges,
  featureFlags,
  groupAdmins,
  roles,
  specialistProfiles,
  staffRoles,
  surveyGroups,
  users,
} from "../db/schema";
import { fullNameOf } from "./auth";
import { badRequest } from "./http";

/**
 * Флаги функций на сервере: кому что включено и правка из техпанели.
 *
 * Правило «включён ли человеку» — одно, в общем пакете (flagEnabledFor):
 * здесь только сбор того, кто спрашивает, — его класс, роли лестницы,
 * группы методик и відділення.
 */

/**
 * Аудитория из строки таблицы — через ту же схему, что на входе.
 *
 * Строка могла лечь до того, как в схеме появился новый разрез, и тогда
 * у неё просто нет этого поля: схема дополнит его пустым списком. Сломанное
 * значение (правка руками в базе) — «никому», а не ошибка на каждый вход:
 * флаг — показ нового, и отказ всей консоли из-за него был бы несоразмерен.
 */
export function audienceOf(raw: unknown): FeatureFlagAudience {
  const parsed = featureFlagAudienceSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptyAudience();
}

/**
 * Кто спрашивает.
 *
 * Под системной ролью, но внутри транзакции запроса: роли лестницы,
 * назначения в группы и профиль приёма — это сведения о самом человеке,
 * только лежат они под политиками, которые пациенту не показывают даже
 * пустое. Чтение ограничено его собственным id.
 */
export async function flagSubjectOf(user: Pick<User, "id" | "role">): Promise<FlagSubject> {
  /*
   * Запросы по очереди, а не Promise.all: они идут в одной транзакции, а
   * asSystem подменяет роль на время вызова — параллельные подмены на одном
   * соединении перепутали бы, кто её возвращает.
   */
  return asSystem(async () => {
    const mine = await db
      .select({ code: roles.code })
      .from(staffRoles)
      .innerJoin(roles, eq(roles.id, staffRoles.roleId))
      .where(eq(staffRoles.userId, user.id));
    const groups = await db
      .select({ groupId: groupAdmins.groupId })
      .from(groupAdmins)
      .where(eq(groupAdmins.userId, user.id));
    const profile = await db
      .select({ departmentId: specialistProfiles.departmentId })
      .from(specialistProfiles)
      .where(eq(specialistProfiles.userId, user.id));
    return {
      id: user.id,
      role: user.role,
      staffRoles: mine.map((r) => r.code),
      surveyGroups: groups.map((g) => g.groupId),
      departments: profile.map((p) => p.departmentId),
    };
  });
}

/**
 * Какие флаги включены человеку — ответ GET /api/flags.
 *
 * Только ключи реестра: строка, пережившая свой ключ в коде, никому ничего
 * не включает. Таблица читается под системной ролью — пациенту политика
 * её не показывает (кому включён какой флаг, ему знать незачем), а свои
 * включённые ключи он узнать вправе.
 */
export async function enabledFlagsFor(user: Pick<User, "id" | "role">): Promise<FeatureFlagKey[]> {
  const rows = await asSystem(() => db.select().from(featureFlags));
  const who = await flagSubjectOf(user);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return FEATURE_FLAG_KEYS.filter((key) => {
    const row = byKey.get(key);
    return row ? flagEnabledFor({ enabled: row.enabled, audience: audienceOf(row.audience) }, who) : false;
  });
}

/** Флаги для техпанели: реестр кода плюс строки таблицы, включая пережившие ключ */
export async function listFlags(): Promise<{ items: OpsFlag[]; names: FlagAudienceNames }> {
  const rows = await db
    .select({ flag: featureFlags, by: users })
    .from(featureFlags)
    .leftJoin(users, eq(users.id, featureFlags.updatedBy));
  const byKey = new Map(rows.map((r) => [r.flag.key, r]));
  const keys = [...FEATURE_FLAG_KEYS, ...rows.map((r) => r.flag.key).filter((k) => !isFeatureFlagKey(k))];
  const items: OpsFlag[] = keys.map((key) => {
    const row = byKey.get(key);
    const entry = isFeatureFlagKey(key) ? FEATURE_FLAGS[key] : null;
    return {
      key,
      known: !!entry,
      title: entry ? { ...entry.title } : null,
      description: entry
        ? { ...entry.description }
        : row?.flag.description
          ? { uk: row.flag.description, ru: row.flag.description, en: row.flag.description }
          : null,
      enabled: row?.flag.enabled ?? false,
      audience: audienceOf(row?.flag.audience),
      updatedAt: row?.flag.updatedAt ?? null,
      updatedBy: row?.by ? fullNameOf(row.by) : null,
    };
  });
  return { items, names: await audienceNames(items.map((i) => i.audience)) };
}

/** Имена для идентификаторов в аудиториях: экран показывает «Олена Іваненко», а не uuid */
export async function audienceNames(list: FeatureFlagAudience[]): Promise<FlagAudienceNames> {
  const pick = (f: (a: FeatureFlagAudience) => string[]) => [...new Set(list.flatMap(f))];
  const userIds = pick((a) => a.users);
  const roleCodes = pick((a) => a.staffRoles);
  const groupIds = pick((a) => a.surveyGroups);
  const departmentIds = pick((a) => a.departments);
  const people = userIds.length ? await db.select().from(users).where(inArray(users.id, userIds)) : [];
  const roleRows = roleCodes.length
    ? await db.select({ code: roles.code, title: roles.title }).from(roles).where(inArray(roles.code, roleCodes))
    : [];
  const groupRows = groupIds.length
    ? await db
        .select({ id: surveyGroups.id, title: surveyGroups.title })
        .from(surveyGroups)
        .where(inArray(surveyGroups.id, groupIds))
    : [];
  const departmentRows = departmentIds.length
    ? await db
        .select({ id: departments.id, title: departments.title })
        .from(departments)
        .where(inArray(departments.id, departmentIds))
    : [];
  return {
    users: Object.fromEntries(people.map((p) => [p.id, fullNameOf(p)])),
    staffRoles: Object.fromEntries(roleRows.map((r) => [r.code, r.title])),
    surveyGroups: Object.fromEntries(groupRows.map((g) => [g.id, g.title])),
    departments: Object.fromEntries(departmentRows.map((d) => [d.id, d.title as never])),
  };
}

/**
 * Проверить, что в аудитории нет выдуманного.
 *
 * Несуществующий id никого не включит, и может показаться, что проверять
 * незачем. Но аудиторию потом читают глазами — «кому включено», — и строка
 * с uuid без имени выглядит как чья-то учётка, которую не удалось показать.
 * Честный отказ на входе дешевле загадки в списке.
 */
async function assertAudienceExists(a: FeatureFlagAudience): Promise<void> {
  const missing = async (ids: string[], found: () => Promise<string[]>) => {
    if (!ids.length) return [];
    const have = new Set(await found());
    return ids.filter((id) => !have.has(id));
  };
  const absent = [
    ...(await missing(a.users, async () =>
      (await db.select({ id: users.id }).from(users).where(inArray(users.id, a.users))).map((r) => r.id),
    )),
    ...(await missing(a.staffRoles, async () =>
      (await db.select({ code: roles.code }).from(roles).where(inArray(roles.code, a.staffRoles))).map((r) => r.code),
    )),
    ...(await missing(a.surveyGroups, async () =>
      (await db.select({ id: surveyGroups.id }).from(surveyGroups).where(inArray(surveyGroups.id, a.surveyGroups))).map(
        (r) => r.id,
      ),
    )),
    ...(await missing(a.departments, async () =>
      (await db.select({ id: departments.id }).from(departments).where(inArray(departments.id, a.departments))).map(
        (r) => r.id,
      ),
    )),
  ];
  if (absent.length) badRequest("err.flagAudienceUnknown", { what: absent.slice(0, 5).join(", ") });
}

/**
 * Правка флага: состояние целиком и строка истории «было → стало».
 *
 * Только ключи реестра. Флаг, которого нет в коде, включать бессмысленно —
 * его никто не спрашивает, — а завести строку под опечатку значило бы
 * получить в техпанели флаг, который «включён», но ничего не делает.
 */
export async function saveFlag(
  authorId: string,
  key: string,
  input: FeatureFlagUpdate,
): Promise<{ before: FlagChange["before"]; after: FlagChange["after"] }> {
  if (!isFeatureFlagKey(key)) badRequest("err.flagUnknown", { key });
  await assertAudienceExists(input.audience);

  const [prev] = await db.select().from(featureFlags).where(eq(featureFlags.key, key));
  const before = prev ? { enabled: prev.enabled, audience: audienceOf(prev.audience) } : null;
  const after = { enabled: input.enabled, audience: input.audience };
  const now = new Date().toISOString();

  await db
    .insert(featureFlags)
    .values({
      key,
      description: FEATURE_FLAGS[key].description.uk,
      enabled: after.enabled,
      audience: after.audience,
      updatedBy: authorId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: featureFlags.key,
      set: {
        description: FEATURE_FLAGS[key].description.uk,
        enabled: after.enabled,
        audience: after.audience,
        updatedBy: authorId,
        updatedAt: now,
      },
    });
  await db.insert(featureFlagChanges).values({
    id: crypto.randomUUID(),
    flagKey: key,
    before,
    after,
    changedBy: authorId,
    changedAt: now,
  });
  return { before, after };
}

/** История флагов для техпанели: свежие сверху */
export async function flagChanges(key: string | undefined, limit: number): Promise<FlagChange[]> {
  const rows = await db
    .select({ change: featureFlagChanges, by: users })
    .from(featureFlagChanges)
    .leftJoin(users, eq(users.id, featureFlagChanges.changedBy))
    .where(key ? eq(featureFlagChanges.flagKey, key) : undefined)
    .orderBy(desc(featureFlagChanges.changedAt))
    .limit(limit);
  return rows.map(({ change, by }) => {
    const before = change.before as { enabled?: boolean; audience?: unknown } | null;
    const after = change.after as { enabled?: boolean; audience?: unknown };
    return {
      id: change.id,
      key: change.flagKey,
      before: before ? { enabled: !!before.enabled, audience: audienceOf(before.audience) } : null,
      after: { enabled: !!after.enabled, audience: audienceOf(after.audience) },
      by: by ? fullNameOf(by) : null,
      at: change.changedAt,
    };
  });
}

