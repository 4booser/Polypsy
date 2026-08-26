import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { User } from "@quizzy/shared";
import { db } from "../db";
import { groupAdmins, surveyAccess, surveys } from "../db/schema";
import { forbidden, notFound } from "./http";

/**
 * Единая точка правды по видимости данных.
 *
 * superadmin — всё; admin — только свои группы плюс собственные методики без группы;
 * user — только опубликованные методики.
 *
 * Все роуты обязаны спрашивать разрешение здесь, а не проверять роль на месте:
 * иначе права неизбежно разъезжаются между эндпоинтами.
 */

/** Есть ли у пациента действующее персональное назначение методики */
export async function hasGrant(userId: string, surveyId: string): Promise<boolean> {
  const row = await db.query.surveyAccess.findFirst({
    where: and(eq(surveyAccess.surveyId, surveyId), eq(surveyAccess.userId, userId)),
  });
  if (!row) return false;
  return !row.expiresAt || new Date(row.expiresAt) > new Date();
}

export const isSuperadmin = (user: User) => user.role === "superadmin";
export const isStaff = (user: User) => user.role === "admin" || user.role === "superadmin";

/** Группы, доступные администратору. null — доступны все (суперадмин). */
export async function accessibleGroupIds(user: User): Promise<string[] | null> {
  if (isSuperadmin(user)) return null;
  const rows = await db
    .select({ groupId: groupAdmins.groupId })
    .from(groupAdmins)
    .where(eq(groupAdmins.userId, user.id));
  return rows.map((r) => r.groupId);
}

/**
 * Условие видимости методик для сотрудника.
 * Возвращает undefined, если ограничивать нечем (суперадмин).
 */
export async function surveyScopeFilter(user: User): Promise<SQL | undefined> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return undefined;

  // Методика в группе управляется ТОЛЬКО через группу: авторство не даёт доступа,
  // иначе создатель сохранял бы доступ к данным отделения после перевода методики
  // в чужую группу. Создатель имеет доступ только к методикам без группы.
  const ownUngrouped = and(isNull(surveys.groupId), eq(surveys.createdBy, user.id));
  if (groupIds.length === 0) return ownUngrouped;
  return or(inArray(surveys.groupId, groupIds), ownUngrouped);
}

/** Может ли сотрудник работать с этой методикой */
export async function canAccessSurvey(user: User, surveyId: string): Promise<boolean> {
  if (isSuperadmin(user)) return true;
  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, surveyId) });
  if (!survey) return false;
  // методика без группы — личный черновик создателя
  if (!survey.groupId) return survey.createdBy === user.id;
  const groupIds = await accessibleGroupIds(user);
  return groupIds?.includes(survey.groupId) ?? false;
}

/** Бросает 404, если методики нет, и 403, если она вне зоны ответственности */
export async function assertSurveyAccess(user: User, surveyId: string): Promise<void> {
  const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, surveyId) });
  if (!survey) notFound("Методика не найдена");
  if (!(await canAccessSurvey(user, surveyId))) {
    forbidden("Методика относится к группе, которой вы не управляете");
  }
}

export async function canAccessGroup(user: User, groupId: string): Promise<boolean> {
  if (isSuperadmin(user)) return true;
  const groupIds = await accessibleGroupIds(user);
  return groupIds?.includes(groupId) ?? false;
}

export async function assertGroupAccess(user: User, groupId: string): Promise<void> {
  if (!(await canAccessGroup(user, groupId))) {
    forbidden("Вы не управляете этой группой");
  }
}
