import { and, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { User } from "@quizzy/shared";
import { db } from "../db";
import {
  appointments,
  batteryItems,
  breakGlass,
  departmentPatients,
  groupAdmins,
  specialistProfiles,
  surveyAccess,
  surveys,
  users,
} from "../db/schema";
import { badRequest, forbidden, notFound } from "./http";
import { t } from "@quizzy/shared";

/**
 * Единая точка правды по видимости данных.
 *
 * superadmin — всё; admin — только свои группы плюс собственные методики без группы;
 * user — только опубликованные методики.
 *
 * Все роуты обязаны спрашивать разрешение здесь, а не проверять роль на месте:
 * иначе права неизбежно разъезжаются между эндпоинтами.
 */

/**
 * Методика в работе, а не снята с использования.
 *
 * Условие для всего, что смотрит вперёд: списки для выдачи, батареи, киоск,
 * новые прохождения. Обратные выборки (карта пациента, аналитика, журнал)
 * его не применяют — снятая методика обязана остаться в уже собранных
 * записях, иначе в клинической истории появятся необъяснённые дыры.
 */
export const surveyInUse = isNull(surveys.archivedAt);

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
 * Пациенты, к которым у сотрудника сейчас открыт доступ «разбить стекло».
 *
 * Отдельная функция, а не флаг внутри скоупа: доступ вне правил обязан быть
 * видимым в коде так же, как он виден в журнале. Спрятанный в общем условии,
 * он через год читался бы как часть обычной логики.
 */
export async function brokenGlassPatients(user: User): Promise<string[]> {
  const now = new Date().toISOString();
  const rows = await db
    .select({ patientId: breakGlass.patientId })
    .from(breakGlass)
    .where(
      and(
        eq(breakGlass.actorId, user.id),
        isNull(breakGlass.revokedAt),
        gt(breakGlass.expiresAt, now),
      ),
    );
  return [...new Set(rows.map((r) => r.patientId))];
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

/**
 * Условие видимости методик при работе с ОДНИМ человеком.
 *
 * Отличается от общего только разбитым стеклом — и в этом весь смысл.
 * Сначала я добавил доступ прямо в `surveyScopeFilter`, и мой же тест поймал
 * утечку: стекло, разбитое ради одного пациента, открывало методику целиком,
 * а всё, что фильтрует по методике, а не по человеку — когорты, аналитика,
 * списки — начинало показывать чужих людей. Обоснование писалось про одного,
 * доступ получался ко всем, кто эту методику проходил.
 *
 * Поэтому доступ вне правил расширяет видимость только вместе с именем того,
 * ради кого стекло разбито.
 */
export async function surveyScopeFilterFor(user: User, patientId: string): Promise<SQL | undefined> {
  const base = await surveyScopeFilter(user);
  if (base === undefined) return undefined;

  const emergency = await brokenGlassPatients(user);
  if (!emergency.includes(patientId)) return base;

  return or(
    base,
    sql`${surveys.id} in (
      select r.survey_id from responses r
      where r.user_id = ${patientId} and r.status = 'completed'
    )`,
  );
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
  if (!survey) notFound("err.surveyNotFound");
  if (!(await canAccessSurvey(user, surveyId))) {
    forbidden("err.surveyOutOfScope");
  }
}

export async function canAccessGroup(user: User, groupId: string): Promise<boolean> {
  if (isSuperadmin(user)) return true;
  const groupIds = await accessibleGroupIds(user);
  return groupIds?.includes(groupId) ?? false;
}

export async function assertGroupAccess(user: User, groupId: string): Promise<void> {
  if (!(await canAccessGroup(user, groupId))) {
    forbidden("err.groupNotManaged");
  }
}


/**
 * Отказывает, если среди методик есть снятые с использования.
 *
 * Одна точка на все пути выдачи — персональное назначение, батарея, киоск,
 * расписание: снятая методика не должна попасть к человеку ни одним из них,
 * а шесть отдельных проверок гарантированно разъедутся.
 */
export async function assertSurveysInUse(surveyIds: string[]): Promise<void> {
  if (!surveyIds.length) return;
  const archived = await db
    .select({ title: surveys.title })
    .from(surveys)
    .where(and(inArray(surveys.id, surveyIds), isNotNull(surveys.archivedAt)));
  if (archived.length === 0) return;
  const names = archived.map((r) => t(r.title as never)).join(", ");
  badRequest("err.retiredSurveys", { names });
}

/** Те же проверки для батареи: её методики целиком */
export async function assertBatteryInUse(batteryId: string): Promise<void> {
  const items = await db
    .select({ surveyId: batteryItems.surveyId })
    .from(batteryItems)
    .where(eq(batteryItems.batteryId, batteryId));
  await assertSurveysInUse(items.map((i) => i.surveyId));
}

/**
 * Методики батареи, оставшиеся в работе.
 *
 * Для автоматических выдач (расписание, каскад): человеку там отказывать
 * некому, а выдавать снятую методику нельзя. Молча пропускаем её и оставляем
 * остальные — расписание продолжает работать в усечённом виде, а не встаёт
 * целиком из-за одной снятой методики.
 */
export async function batterySurveysInUse(batteryId: string): Promise<string[]> {
  const rows = await db
    .select({ id: surveys.id })
    .from(batteryItems)
    .innerJoin(surveys, eq(surveys.id, batteryItems.surveyId))
    .where(and(eq(batteryItems.batteryId, batteryId), isNull(surveys.archivedAt)));
  return rows.map((r) => r.id);
}


/**
 * Идентификаторы пациентов в зоне ответственности сотрудника.
 *
 * `null` — ограничений нет (суперадмин). Пустое множество — сотрудник не
 * видит никого: у него нет групп либо в его группах ещё никто не появлялся.
 *
 * Человек попадает в зону тремя путями: ему назначили методику группы, он
 * прошёл методику группы или ему назначили батарею группы. Такой же набор
 * условий уже применялся на экране пациентов; здесь он вынесен, чтобы
 * маршруты и списки не разошлись в понимании слова «свой».
 */
export async function accessiblePatientIds(user: User): Promise<Set<string> | null> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return null;

  // разбитое стекло добавляет ровно тех, ради кого его разбивали
  const emergency = await brokenGlassPatients(user);

  /*
   * Приём — самостоятельное основание видеть человека, и оно не зависит от
   * групп методик.
   *
   * Прежний набор условий считал пациента своим, только если он соприкасался
   * с методиками группы администратора. Первичный приём это допущение
   * ломает: человек записывается с телефона, ни разу ничего не пройдя, — и
   * специалист, к которому он записан, увидел бы его в расписании и не нашёл
   * бы в карте. Поэтому «у меня к нему приём» и «он прикреплён к отделению,
   * где я принимаю» считаются наравне.
   *
   * Считается отдельным запросом, а не ещё одним условием в общем: пустая
   * зона по группам не должна отменять приёмы — и именно так было бы, если
   * дописать условие внутрь ветки, которая до этого места не доходит.
   */
  const byClinic = await db
    .select({ id: appointments.patientId })
    .from(appointments)
    .where(eq(appointments.specialistId, user.id));
  const byDepartment = await db
    .select({ id: departmentPatients.patientId })
    .from(departmentPatients)
    .innerJoin(
      specialistProfiles,
      eq(specialistProfiles.departmentId, departmentPatients.departmentId),
    )
    .where(
      and(eq(specialistProfiles.userId, user.id), isNull(departmentPatients.detachedAt)),
    );
  const clinic = [...byClinic.map((r) => r.id), ...byDepartment.map((r) => r.id)];

  if (!groupIds.length) return new Set([...emergency, ...clinic]);

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "user"),
        sql`(
          exists (select 1 from survey_access sa
            join surveys s on s.id = sa.survey_id
            where sa.user_id = "users"."id" and s.group_id in ${groupIds})
          or exists (select 1 from responses r
            join surveys s on s.id = r.survey_id
            where r.user_id = "users"."id" and s.group_id in ${groupIds})
          or exists (select 1 from battery_assignments ba
            join batteries b on b.id = ba.battery_id
            where ba.user_id = "users"."id" and b.group_id in ${groupIds})
        )`,
      ),
    );

  return new Set([...rows.map((r) => r.id), ...emergency, ...clinic]);
}

/**
 * Отказать, если пациент вне зоны ответственности.
 *
 * Отвечает «не найдено», а не «нельзя»: 403 подтвердил бы, что такой человек
 * в системе есть, — а по коду отказа этого узнавать не следует.
 */
export async function assertPatientAccess(user: User, patientId: string): Promise<void> {
  const allowed = await accessiblePatientIds(user);
  if (allowed === null) return;
  if (!allowed.has(patientId)) notFound("err.userNotFound");
}
