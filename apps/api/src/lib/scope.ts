import { and, eq, gt, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { User } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import {
  appointments,
  batteryItems,
  breakGlass,
  departmentPatients,
  filterPresets,
  groupAdmins,
  mailings,
  patientGroups,
  specialistProfiles,
  statModels,
  surveyAccess,
  surveyFolders,
  surveys,
  users,
  type FilterPresetRow,
  type MailingRow,
  type StatModelRow,
  type SurveyFolderRow,
} from "../db/schema";
import { badRequest, forbidden, notFound } from "./http";
import { t } from "@quizzy/shared";

/**
 * Единая точка правды по видимости данных.
 *
 * superadmin — всё; admin — свои группы, собственные методики без группы и
 * библиотека (общий каталог методик, см. ниже); user — только опубликованные
 * методики.
 *
 * У методики три вопроса, и ответы на них разные:
 *  - пользоваться (найти, прочитать паспорт, пункты, ключ и нормы, назначить,
 *    провести, поставить в набор) — surveyUseFilter, assertSurveyUse;
 *  - править (конструктор, версии, настройки, снятие) — assertSurveyManage;
 *  - видеть результаты (прохождения и всё, что на них висит: ответы, баллы,
 *    тревоги, случаи, срабатывания правил, динамика, аналитика, выгрузки) —
 *    resultScopeCondition, surveyResultScope, canSeeResult, surveyScopeFilterFor.
 * Для методик своих групп и своих без группы все три совпадают, как и
 * прежде. Расходятся они у библиотеки.
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

/**
 * Группы под управлением сотрудника (group_admins). null — все (суперадмин).
 *
 * Это право править методики группы и распоряжаться ею. Видимость данных
 * считается от них же, но без библиотеки — см. ownGroupsOf.
 */
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

/* ─────────── Библиотека: общий каталог методик ───────────
 *
 * Методики общего каталога (установщик, lib/catalogInstall.ts) стоят в своей
 * группе — CATALOG_GROUP_ID. Прежде это была обычная группа: кого суперадмин
 * назначит её администратором, тот видит её методики и все их прохождения, а
 * остальные — ничего. На стенде, похожем на бой, врач без этой группы видел
 * у каждого из ста двадцати пациентов «замеров нет»; на проде врачей
 * назначали администраторами каталога руками — и это делало их редакторами
 * выверенных методик, а через путь «прошёл методику группы» (зона ниже) — ещё
 * и открывало им каждого, кто когда-либо проходил любую методику каталога, из
 * любого отделения.
 *
 * Теперь каталог — библиотека всех сотрудников, и три вопроса разведены:
 *  - пользуется ею каждый сотрудник, без назначения в группу;
 *  - результаты её методик видны только о людях, которые и так в зоне
 *    сотрудника (отделение, приём, разбитое стекло, пути через СВОИ группы),
 *    и о нём самом. Библиотека зону не расширяет никогда: прошедший методику
 *    каталога не становится виден всем сотрудникам — ни через выдачу, ни
 *    через прохождение, ни через набор;
 *  - правят её суперадмин и явные администраторы группы каталога, как и
 *    прежде. Их строки group_admins остаются, но больше ничего не открывают:
 *    ни прохождений сверх зоны, ни людей.
 *
 * То же правило держит политика строк (миграция 0134, rls_library_survey_ids
 * и rls_admin_sees_patient) — расходиться им не из чего: группа библиотеки
 * названа в ней тем же идентификатором, и сверяет их test/catalogLibrary.test.ts.
 */

/** Группа общего каталога — библиотека методик всех сотрудников */
export const CATALOG_GROUP_ID = "catalog";

/** Методика библиотеки — условием над surveys */
export const librarySurvey = eq(surveys.groupId, CATALOG_GROUP_ID);

/**
 * Группы, по которым сотрудник видит данные целиком и через которые к нему
 * попадают люди: свои, кроме библиотеки. Администратор группы каталога её
 * правит, но её результаты видит по тому же правилу, что любой сотрудник.
 */
function ownGroupsOf(groupIds: readonly string[]): string[] {
  return groupIds.filter((id) => id !== CATALOG_GROUP_ID);
}

/**
 * Методика в группе управляется ТОЛЬКО через группу: авторство не даёт доступа,
 * иначе создатель сохранял бы доступ к данным отделения после перевода методики
 * в чужую группу. Создатель имеет доступ только к методикам без группы.
 */
function ownUngrouped(user: User): SQL {
  return and(isNull(surveys.groupId), eq(surveys.createdBy, user.id))!;
}

/** «Свои» методики — те, у которых видны все прохождения: свои группы без библиотеки и свои без группы */
function ownSurveyCondition(user: User, groupIds: readonly string[]): SQL {
  const own = ownGroupsOf(groupIds);
  return own.length ? or(inArray(surveys.groupId, own), ownUngrouped(user))! : ownUngrouped(user);
}

/** То же условием над псевдонимом методики в сыром SQL */
function ownSurveySql(user: User, groupIds: readonly string[], alias: string): SQL {
  const s = sql.raw(alias);
  const own = ownGroupsOf(groupIds);
  return own.length
    ? sql`(${s}.group_id in ${own} or (${s}.group_id is null and ${s}.created_by = ${user.id}))`
    : sql`(${s}.group_id is null and ${s}.created_by = ${user.id})`;
}

/**
 * Методики, которыми сотрудник вправе пользоваться: свои группы, свои без
 * группы и библиотека. undefined — ограничивать нечем (суперадмин).
 *
 * Только о самих методиках: список каталога, шаги наборов, выбор методики.
 * Чьи прохождения при этом видны — отдельный вопрос (resultScopeCondition):
 * библиотека, которой пользуется каждый, не делает видимыми чужих людей.
 */
export async function surveyUseFilter(user: User): Promise<SQL | undefined> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return undefined;
  return or(librarySurvey, groupIds.length ? inArray(surveys.groupId, groupIds) : undefined, ownUngrouped(user));
}

/**
 * То же, что surveyUseFilter, — над псевдонимом методики в сыром SQL.
 *
 * Для подзапросов о людях, которые уже отобраны зоной (реестр пациентов):
 * у них «методика, которой пользуюсь» и есть правило результатов — своя
 * методика или библиотека о человеке зоны.
 */
export async function surveyUseSql(user: User, alias: string): Promise<SQL | undefined> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return undefined;
  const s = sql.raw(alias);
  const managed = groupIds.length ? sql` or ${s}.group_id in ${groupIds}` : sql``;
  return sql`(${s}.group_id = ${CATALOG_GROUP_ID}${managed} or (${s}.group_id is null and ${s}.created_by = ${user.id}))`;
}

/**
 * Методики, по которым сотрудник видит все прохождения: свои группы, кроме
 * библиотеки, и свои без группы. undefined — суперадмин.
 *
 * Для разборов, которым нужна методика без человека — поток событий
 * сверяет по ней событие, у которого человека нет. Где человек есть,
 * спрашивать надо resultScopeCondition.
 */
export async function ownSurveyFilter(user: User): Promise<SQL | undefined> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return undefined;
  return ownSurveyCondition(user, groupIds);
}

interface SurveyOwnership {
  groupId: string | null;
  createdBy: string;
}

/** Своя ли методика: группа под управлением (библиотека тоже — её администратору) или своя без группы */
function manages(user: User, survey: SurveyOwnership, groupIds: readonly string[]): boolean {
  if (!survey.groupId) return survey.createdBy === user.id;
  return groupIds.includes(survey.groupId);
}

/** Строка методики под контекстом запроса: под ролью приложения чужую прячет политика surveys_read */
function ownershipOf(surveyId: string): Promise<SurveyOwnership | undefined> {
  return db.query.surveys.findFirst({
    where: eq(surveys.id, surveyId),
    columns: { groupId: true, createdBy: true },
  });
}

/**
 * Методика библиотеки? Выдача её в зону не вводит: назначают её только
 * человеку, который уже в зоне сотрудника (routes/access.ts, батареи).
 * Системной ролью, как существование методики: вопрос о методике, а не о
 * данных, и ответ нужен до того, как читающему откажут или разрешат.
 */
export async function isLibrarySurvey(surveyId: string): Promise<boolean> {
  const row = await asSystem(() =>
    db.query.surveys.findFirst({ where: eq(surveys.id, surveyId), columns: { groupId: true } }),
  );
  return row?.groupId === CATALOG_GROUP_ID;
}

/** Может ли сотрудник пользоваться методикой: читать, назначать, проводить, ставить в набор */
export async function canUseSurvey(user: User, surveyId: string): Promise<boolean> {
  if (isSuperadmin(user)) return true;
  const survey = await ownershipOf(surveyId);
  if (!survey) return false;
  if (survey.groupId === CATALOG_GROUP_ID) return true;
  return manages(user, survey, (await accessibleGroupIds(user)) ?? []);
}

/** Может ли сотрудник править методику: конструктор, версии, настройки, перенос, снятие */
export async function canManageSurvey(user: User, surveyId: string): Promise<boolean> {
  if (isSuperadmin(user)) return true;
  const survey = await ownershipOf(surveyId);
  if (!survey) return false;
  return manages(user, survey, (await accessibleGroupIds(user)) ?? []);
}

/**
 * Существование методики — системной ролью.
 *
 * Под ролью приложения чужую методику политика surveys_read прячет, и в бою
 * «вне зоны» не наступало никогда: администратор чужой группы получал
 * «методику не найдено», а сюита владельцем — 403, и тесты проверяли ответ,
 * которого в бою не бывает (волна 13, обход всех GET под ролью приложения).
 * Методика — не персональные данные: различать «нет такой» и «не ваша» здесь
 * решено намеренно (см. папки методик ниже), и решение должно держаться в
 * бою, а не только в сюите. Из строки берётся одно «есть ли» — сама методика
 * по-прежнему читается под политикой.
 */
async function assertSurveyExists(surveyId: string): Promise<void> {
  const survey = await asSystem(() =>
    db.query.surveys.findFirst({ where: eq(surveys.id, surveyId), columns: { id: true } }),
  );
  if (!survey) notFound("err.surveyNotFound");
}

/** 404, если методики нет; 403, если пользоваться ею сотруднику нельзя */
export async function assertSurveyUse(user: User, surveyId: string): Promise<void> {
  await assertSurveyExists(surveyId);
  if (!(await canUseSurvey(user, surveyId))) forbidden("err.surveyOutOfScope");
}

/**
 * 404, если методики нет; 403, если править её сотруднику нельзя.
 *
 * Методика библиотеки, которой сотрудник пользуется, но не правит, — свой
 * отказ: «вне зоны» было бы неправдой о методике, которую он только что
 * назначал, а ответ должен сказать, кто её правит.
 */
export async function assertSurveyManage(user: User, surveyId: string): Promise<void> {
  await assertSurveyExists(surveyId);
  if (await canManageSurvey(user, surveyId)) return;
  if (await canUseSurvey(user, surveyId)) forbidden("err.surveyLibraryReadOnly");
  forbidden("err.surveyOutOfScope");
}

/* ─────────── Результаты: прохождения и всё, что на них висит ─────────── */

/** Условие над колонкой «человек» выборки */
export type PatientCondition = (patientId: SQL | AnyPgColumn) => SQL;

/** Условие над колонками «методика» и «человек» выборки */
export type ResultScope = (surveyId: SQL | AnyPgColumn, patientId: SQL | AnyPgColumn) => SQL;

/** Человек — сам сотрудник или человек его зоны: кому видны результаты библиотеки */
function libraryPatient(user: User, inZone: PatientCondition): PatientCondition {
  return (patientId) => sql`(${patientId} = ${user.id} or ${inZone(patientId)})`;
}

/**
 * Видимость результатов условием SQL — над колонками «методика» и «человек».
 *
 * Прохождение (тревога, случай, срабатывание, выдача…) видно, если его
 * методика своя (свои группы без библиотеки, свои без группы) — все, как и
 * прежде, — или методика библиотеки, а человек — сам сотрудник или в его
 * зоне. Анонимное прохождение библиотеки (человека нет) не видно никому,
 * кроме суперадмина: зоны у него нет.
 *
 * Методика — множеством (`… in (select …)`): оно считается один раз на
 * запрос (hashed SubPlan), как в политике строк (0120). Зона — условием о
 * человеке строки (patientScopeCondition, #181) и только у строк
 * библиотеки: своя методика отвечает раньше.
 *
 * `inZone` — зона, уже посчитанная запросом (очередь работы спрашивает её
 * для своих строк): тогда второй раз она не считается. Без неё зона
 * считается здесь и идёт в счётчик зоны, как любая её форма.
 *
 * `null` — ограничений нет (суперадмин).
 */
export async function resultScopeCondition(user: User, inZone?: PatientCondition | null): Promise<ResultScope | null> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return null;
  const zone = libraryPatient(user, inZone ?? countedZone(user, groupIds));
  // псевдоним — свой, как у зоны (zoneCondition): условие ставят внутрь чужих запросов
  const own = ownSurveySql(user, groupIds, "zos");
  return (surveyId, patientId) => sql`(${surveyId} in (select zos.id from surveys zos where ${own})
    or (${surveyId} in (select zls.id from surveys zls where zls.group_id = ${CATALOG_GROUP_ID}) and ${zone(patientId)}))`;
}

/**
 * resultScopeCondition для сырого SQL и списков условий: у суперадмина —
 * `true`, а не null, чтобы условие стояло в тексте запроса без ветвлений.
 */
export async function resultScope(user: User, inZone?: PatientCondition | null): Promise<ResultScope> {
  return (await resultScopeCondition(user, inZone)) ?? (() => sql`true`);
}

/**
 * Чьи прохождения ОДНОЙ методики видит сотрудник — для экранов одной
 * методики: аналитика, список прохождений, выгрузки, качество данных,
 * статистика, нормы, назначения.
 *
 * `undefined` — все (суперадмин, своя методика); условие над колонкой
 * «человек» — методика библиотеки: только сам сотрудник и люди его зоны.
 * Методикой сотрудник обязан мочь пользоваться — отказ тот же, что у
 * assertSurveyUse.
 */
export async function surveyResultScope(user: User, surveyId: string): Promise<PatientCondition | undefined> {
  await assertSurveyExists(surveyId);
  if (isSuperadmin(user)) return undefined;
  // то же, что assertSurveyUse, но строка методики и группы читаются один раз
  const survey = await ownershipOf(surveyId);
  if (!survey) forbidden("err.surveyOutOfScope");
  const groupIds = (await accessibleGroupIds(user)) ?? [];
  if (survey.groupId === CATALOG_GROUP_ID) return libraryPatient(user, countedZone(user, groupIds));
  if (!manages(user, survey, groupIds)) forbidden("err.surveyOutOfScope");
  return undefined;
}

/**
 * Видит ли сотрудник одну запись результата — прохождение, тревогу, случай,
 * срабатывание правила. Правило то же, что у resultScopeCondition; человек —
 * вопросом о нём одном (patientsInScope), а не построением зоны.
 */
export async function canSeeResult(
  user: User,
  record: { surveyId: string; userId: string | null },
): Promise<boolean> {
  if (isSuperadmin(user)) return true;
  const survey = await ownershipOf(record.surveyId);
  if (!survey) return false;
  if (survey.groupId !== CATALOG_GROUP_ID) return manages(user, survey, (await accessibleGroupIds(user)) ?? []);
  if (!record.userId) return false;
  if (record.userId === user.id) return true;
  const allowed = await patientsInScope(user, [record.userId]);
  return allowed === null || allowed.has(record.userId);
}

/* ─────────── Назначения наборов ─────────── */

/**
 * Вводит ли назначение набора человека в зону сотрудника.
 *
 * Набор своей группы — да: это путь «назначили набор группы» (зона ниже).
 * Общий набор (без группы — им пользуются все отделения, так стоят и
 * заготовки каталога) и набор группы библиотеки — нет: их назначают только
 * человеку, который уже в зоне, иначе назначивший не увидел бы потом ни
 * назначения, ни результатов (routes/batteries.ts).
 */
export async function batteryWidensZone(user: User, battery: { groupId: string | null }): Promise<boolean> {
  if (!battery.groupId || battery.groupId === CATALOG_GROUP_ID) return false;
  const groupIds = await accessibleGroupIds(user);
  return groupIds === null || groupIds.includes(battery.groupId);
}

/**
 * Видимость назначений наборов условием — над колонками «набор» и «человек».
 *
 * Назначение набора своей группы (не библиотеки) видно всегда: оно и вводит
 * человека в зону. Назначение общего набора и набора библиотеки — только о
 * человеке зоны: общий набор назначают все отделения, и список его
 * назначений с шагами, датами и прохождениями иначе называл бы пациентов
 * чужих отделений. Политика строк battery_assignments — та же (0134).
 *
 * `inZone` — зона, уже посчитанная запросом; без неё считается здесь.
 * `null` — суперадмин.
 */
export async function batteryAssignmentScope(
  user: User,
  inZone?: PatientCondition | null,
): Promise<((batteryId: SQL | AnyPgColumn, patientId: SQL | AnyPgColumn) => SQL) | null> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return null;
  const own = ownGroupsOf(groupIds);
  const zone = inZone ?? countedZone(user, groupIds);
  return (batteryId, patientId) =>
    own.length
      ? sql`(${batteryId} in (select zob.id from batteries zob where zob.group_id in ${own}) or ${zone(patientId)})`
      : zone(patientId);
}

/**
 * Методики, результаты которых сотрудник видит об ОДНОМ человеке: карточка,
 * динамика, хронология, сводка направления, печатная карта.
 *
 * Свои методики — как всегда; библиотека — если человек в зоне сотрудника;
 * и разбитое стекло. Зона о человеке спрашивается тем же запросом, что
 * читает методики: отдельного похода в базу нет, а вызывающий, забывший
 * проверить человека, библиотеку не откроет.
 *
 * Стекло отличается от общего правила — и в этом весь смысл. Сначала я
 * добавил доступ прямо в общее условие методик, и мой же тест поймал
 * утечку: стекло, разбитое ради одного пациента, открывало методику целиком,
 * а всё, что фильтрует по методике, а не по человеку — когорты, аналитика,
 * списки — начинало показывать чужих людей. Обоснование писалось про одного,
 * доступ получался ко всем, кто эту методику проходил.
 *
 * Поэтому доступ вне правил расширяет видимость только вместе с именем того,
 * ради кого стекло разбито.
 */
export async function surveyScopeFilterFor(user: User, patientId: string): Promise<SQL | undefined> {
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return undefined;

  const library = and(librarySurvey, zoneCondition(user, groupIds)(sql`${patientId}`));
  const emergency = await brokenGlassPatients(user);
  const glass = emergency.includes(patientId)
    ? sql`${surveys.id} in (
        select r.survey_id from responses r
        where r.user_id = ${patientId} and r.status = 'completed'
      )`
    : undefined;

  return or(ownSurveyCondition(user, groupIds), library, glass);
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

/* ─────────── Папки МЕТОДИК ───────────
 *
 * Папка видна тем, кому видна её группа, и ровно так же правится. Правило
 * не своё, а группы: папка ничего не открывает и не закрывает, она полка
 * внутри уже открытой области. Поэтому здесь нет второй функции видимости,
 * которая могла бы разойтись с первой: вопрос «моя ли папка» сводится к
 * вопросу «моя ли группа», и отвечает на него assertGroupAccess.
 */

/**
 * Папка по идентификатору — или отказ.
 *
 * «Не найдено», если папки нет; «не управляете группой», если она чужая.
 * Ответы разные намеренно, в отличие от групп пациентов: там 403 выдал бы
 * существование чужого личного списка, а папка методик не личная и о людях
 * ничего не говорит. Порядок тот же, что у самой методики
 * (assertSurveyUse): сначала 404, затем 403 по группе.
 */
export async function assertSurveyFolderAccess(user: User, folderId: string): Promise<SurveyFolderRow> {
  /*
   * Системной ролью — по той же причине, что существование методики в
   * assertSurveyUse: чужую папку прячет политика, и в бою вместо «не
   * управляете группой» отвечало «не найдено» (волна 13). Строка отдаётся
   * вызывающему только после проверки группы ниже.
   */
  const folder = await asSystem(() => db.query.surveyFolders.findFirst({ where: eq(surveyFolders.id, folderId) }));
  if (!folder) notFound("err.surveyFolderNotFound");
  await assertGroupAccess(user, folder.groupId);
  return folder;
}

/* ─────────── Группы ПАЦИЕНТОВ ───────────
 *
 * Правило видимости живёт здесь, рядом с остальными, а не в маршрутах — по
 * той же причине, по которой сюда снесены все прочие: два механизма ответа
 * на вопрос «кому что видно» неизбежно разъезжаются, и разъезд виден не
 * сразу, а на маршруте, который забыли поправить.
 *
 * Правило простое и намеренно НЕ повторяет правило групп методик. Группу
 * методик ведут несколько администраторов, и видит её каждый из них —
 * потому что группа методик выражает структуру учреждения. Группа пациентов
 * выражает решение одного человека: он собрал список руками, назвал его
 * «Група ризику» и задал ему свой вопрос. Отдать такой список всему
 * отделению значило бы выдать личную рабочую раскладку за официальную — и
 * второй специалист, увидев чужую «группу риска», прочитал бы её как
 * заключение учреждения о людях.
 *
 * Если общий список понадобится, его заводят явным признаком «общая», как
 * это сделано у saved_views: осознанным действием владельца, а не тем, что
 * правило однажды написали шире, чем думали.
 */

/** Своя ли это группа пациентов. Суперадмин видит все: ему разбирать чужие */
export async function canAccessPatientGroup(user: User, groupId: string): Promise<boolean> {
  if (isSuperadmin(user)) return true;
  const row = await db.query.patientGroups.findFirst({ where: eq(patientGroups.id, groupId) });
  return row?.ownerId === user.id;
}

/**
 * Отказать, если группа пациентов чужая или её нет.
 *
 * Отвечает «не найдено», а не «нельзя» — ровно как assertPatientAccess ниже:
 * 403 подтвердил бы, что группа с таким идентификатором в системе есть, а
 * вместе с ней и то, что коллега такую завёл. По коду отказа этого узнавать
 * не следует.
 */
export async function assertPatientGroupAccess(user: User, groupId: string): Promise<void> {
  if (!(await canAccessPatientGroup(user, groupId))) notFound("err.patientGroupNotFound");
}

/* ─────────── Раздел «Статистика»: пресеты фильтров и модели ───────────
 *
 * Правило то же, что у групп пациентов, и по той же причине: пресет и
 * модель выражают вопрос одного аналитика, а не структуру учреждения, и
 * коллега прочитал бы чужой срез как принятый в отделении. Видит и правит
 * владелец; суперадмин — всё, ему разбирать.
 *
 * Отвечает «не найдено», а не «нельзя», как assertPatientGroupAccess: 403
 * подтвердил бы, что коллега такое завёл.
 *
 * Возвращают строку, а не только проверяют: маршруту она нужна следующей же
 * строкой, и второй запрос за тем, что уже прочитано, был бы платой за
 * симметрию с проверками, у которых строка не нужна.
 */

/**
 * Замок на строке пресета — на остаток транзакции запроса.
 *
 * Пресет и модель согласованы по его строке (внешний разбор 2026-09-30,
 * #106): модель хранит presetId в jsonb, внешнего ключа нет, и удаление
 * «никем не занятого» пресета успевало пройти проверку «моделей нет» до
 * того, как создание модели на нём зафиксировалось — обоим успех, а модель
 * потом не запускалась. Удаление берёт строку FOR UPDATE и считает модели
 * уже под замком; создание и правка модели берут FOR KEY SHARE на каждый
 * пресет колонки — замок, с которым удаление несовместимо, а правка
 * названия и критериев (обычный UPDATE) — совместима. Кто первым встал за
 * строкой, тот и прошёл; второй видит итог первого: пресета нет (404) или
 * модель уже есть (400 «используется»).
 */
export type PresetLock = "update" | "key share";

export async function assertFilterPresetAccess(
  user: User,
  presetId: string,
  lock?: PresetLock,
): Promise<FilterPresetRow> {
  const row = lock
    ? (await db.select().from(filterPresets).where(eq(filterPresets.id, presetId)).for(lock))[0]
    : await db.query.filterPresets.findFirst({ where: eq(filterPresets.id, presetId) });
  if (!row || (!isSuperadmin(user) && row.ownerId !== user.id)) notFound("err.filterPresetNotFound");
  return row;
}

export async function assertStatModelAccess(user: User, modelId: string): Promise<StatModelRow> {
  const row = await db.query.statModels.findFirst({ where: eq(statModels.id, modelId) });
  if (!row || (!isSuperadmin(user) && row.ownerId !== user.id)) notFound("err.statModelNotFound");
  return row;
}

/* ─────────── Рассылки ───────────
 *
 * То же правило, что у групп пациентов, и по той же причине: рассылка —
 * вопрос одного специалиста своим людям, а не документ отделения. Видит и
 * правит автор; суперадмин — все, ему разбирать чужие экраны. Получатель
 * ходит другими маршрутами (inbox, ответ) и здесь не проверяется: его право
 * — строка в mailing_recipients, а не авторство.
 */

/**
 * Рассылка по идентификатору — или «не найдено».
 *
 * «Не найдено», а не «нельзя»: 403 подтвердил бы, что коллега такую
 * рассылку завёл, — а по коду отказа этого узнавать не следует.
 */
export async function assertMailingAccess(user: User, mailingId: string): Promise<MailingRow> {
  const row = await db.query.mailings.findFirst({ where: eq(mailings.id, mailingId) });
  if (!row || (!isSuperadmin(user) && row.authorId !== user.id)) notFound("err.mailingNotFound");
  return row;
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
 * маршруты и списки не разошлись в понимании слова «свой». Группа — своя и
 * не библиотека (ownGroupsOf): методика каталога, которую проходят люди всех
 * отделений, в зону не вводит никого.
 *
 * Только там, где нужен весь список. Вопрос об одном или нескольких
 * названных людях — patientsInScope ниже: строить ради них всю зону стоит
 * секунд на каждом запросе (#181).
 */
/*
 * Счётчик вызовов — для проверки, а не для наблюдения за боем.
 *
 * Зона видимости обязана считаться один раз на запрос: однажды очередь
 * работы посчитала её дважды, и смоук замедлился вдвое. Проверить это
 * секундомером не выходит — зона считается быстро, и полсотни лишних
 * вычислений укладываются в любой разумный порог; проверка выглядела бы
 * рабочей, ничего не проверяя. Считать вызовы — единственный способ
 * спросить ровно то, что нужно.
 *
 * Стоит одно целочисленное увеличение на вызов. Считаются все формы зоны:
 * список (accessiblePatientIds), условие (patientScopeCondition) и зона
 * внутри видимости результатов (resultScopeCondition без готовой зоны,
 * surveyResultScope у методики библиотеки).
 */
let scopeCalls = 0;

export function scopeCallsForTests(): number {
  return scopeCalls;
}

export function resetScopeCallsForTests(): void {
  scopeCalls = 0;
}

export async function accessiblePatientIds(user: User): Promise<Set<string> | null> {
  scopeCalls += 1;
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

  const own = ownGroupsOf(groupIds);
  if (!own.length) return new Set([...emergency, ...clinic]);

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.role, "user"),
        sql`(
          exists (select 1 from survey_access sa
            join surveys s on s.id = sa.survey_id
            where sa.user_id = "users"."id" and s.group_id in ${own})
          or exists (select 1 from responses r
            join surveys s on s.id = r.survey_id
            where r.user_id = "users"."id" and s.group_id in ${own})
          or exists (select 1 from battery_assignments ba
            join batteries b on b.id = ba.battery_id
            where ba.user_id = "users"."id" and b.group_id in ${own})
        )`,
      ),
    );

  return new Set([...rows.map((r) => r.id), ...emergency, ...clinic]);
}

/**
 * Правило зоны условием SQL — над ссылкой на id человека.
 *
 * То же правило, что у accessiblePatientIds выше, но вопросом о людях, а не
 * списком всех (#181). Вопрос «можно ли к этому человеку» задаётся на каждой
 * карточке, в каждом эпизоде и печатной карте, а отвечался построением всей
 * зоны: на учреждении в пять тысяч пациентов — секунды и соединение пула на
 * каждый такой запрос, и десяток врачей, открывших по карточке, занимали пул
 * целиком. Условием база проверяет только тех, о ком спросили или кто попал
 * в выборку, по индексам их строк: время и число запросов не зависят от
 * того, сколько людей в зоне.
 *
 * Пути — те же, и те же отличия между ними: разбитое стекло, приём и
 * отделение считаются для любой учётной записи, а связь через группу
 * методик — только для обследуемых (role = 'user'). Два способа сказать
 * одно правило могут разойтись; держит их вместе проверка эквивалентности
 * (test/patientScope.test.ts) — правка одного без другого её роняет.
 *
 * Группы сотрудника читаются один раз, условие строится для любой колонки:
 * очередь работы применяет его к трём таблицам. Вызов идёт в счётчик зоны
 * наравне с полным списком — «один раз на запрос» относится к обоим.
 *
 * `null` — ограничений нет (суперадмин).
 */
export async function patientScopeCondition(user: User): Promise<PatientCondition | null> {
  scopeCalls += 1;
  const groupIds = await accessibleGroupIds(user);
  if (groupIds === null) return null;
  return zoneCondition(user, groupIds);
}

/** Условие зоны, посчитанное как отдельная её форма — со счётчиком (см. scopeCalls) */
function countedZone(user: User, groupIds: readonly string[]): PatientCondition {
  scopeCalls += 1;
  return zoneCondition(user, groupIds);
}

/**
 * Само правило зоны — построитель условия по уже прочитанным группам.
 *
 * Без счётчика: его зовут формы зоны выше (patientScopeCondition,
 * resultScopeCondition, surveyResultScope — каждая считается сама) и
 * surveyScopeFilterFor, которая спрашивает о человеке тем же запросом, что
 * читает методики, — отдельного вычисления зоны там нет.
 */
function zoneCondition(user: User, groupIds: readonly string[]): PatientCondition {
  const now = new Date().toISOString();
  const own = ownGroupsOf(groupIds);
  /*
   * Псевдонимы подзапросов — свои, с приставкой z: условие ставят над
   * колонкой чужого запроса (`a.user_id` у назначений наборов, `r.user_id` у
   * прохождений), и короткий псевдоним здесь перекрыл бы её — `a.patient_id
   * = a.user_id` внутри `from appointments a` спрашивал бы не того человека.
   */
  return (patientId) => {
    const outsideGroups = sql`exists (select 1 from break_glass zbg
          where zbg.actor_id = ${user.id} and zbg.patient_id = ${patientId}
            and zbg.revoked_at is null and zbg.expires_at > ${now}::timestamptz)
      or exists (select 1 from appointments zap
          where zap.specialist_id = ${user.id} and zap.patient_id = ${patientId})
      or exists (select 1 from department_patients zdp
          join specialist_profiles zsp on zsp.department_id = zdp.department_id
          where zsp.user_id = ${user.id} and zdp.patient_id = ${patientId} and zdp.detached_at is null)`;
    if (!own.length) return sql`(${outsideGroups})`;
    return sql`(${outsideGroups}
      or exists (select 1 from users zu where zu.id = ${patientId} and zu.role = 'user' and (
        exists (select 1 from survey_access zsa join surveys zs on zs.id = zsa.survey_id
          where zsa.user_id = zu.id and zs.group_id in ${own})
        or exists (select 1 from responses zr join surveys zs on zs.id = zr.survey_id
          where zr.user_id = zu.id and zs.group_id in ${own})
        or exists (select 1 from battery_assignments zba join batteries zb on zb.id = zba.battery_id
          where zba.user_id = zu.id and zb.group_id in ${own}))))`;
  };
}

/**
 * Сотрудники, в чьей зоне человек, — та же зона, увиденная со стороны
 * человека: разбитое стекло, приём, прикрепление к отделению, пути через
 * свои группы (не библиотеку). Действующие учётные записи персонала, без
 * суперадминов: у тех зоны нет, они видят всех.
 *
 * Нужна адресатам тревоги по методике библиотеки (lib/notify.ts): её
 * получают те, кто ведёт человека, а не администраторы каталога — тем она
 * была бы и чужой (человек вне их зоны), и не дошла бы до его врача. Третья
 * запись одного правила рядом с двумя выше; держит их вместе сверка с
 * patientsInScope (test/catalogLibrary.test.ts).
 */
export async function staffInChargeOf(patientId: string): Promise<{ id: string; email: string }[]> {
  const now = new Date().toISOString();
  const rows = await db.execute<{ id: string; email: string }>(sql`
    select st.id, st.email from users st
    where st.role = 'admin' and st.disabled_at is null and (
      exists (select 1 from break_glass zbg
          where zbg.actor_id = st.id and zbg.patient_id = ${patientId}
            and zbg.revoked_at is null and zbg.expires_at > ${now}::timestamptz)
      or exists (select 1 from appointments zap
          where zap.specialist_id = st.id and zap.patient_id = ${patientId})
      or exists (select 1 from department_patients zdp
          join specialist_profiles zsp on zsp.department_id = zdp.department_id
          where zsp.user_id = st.id and zdp.patient_id = ${patientId} and zdp.detached_at is null)
      or exists (select 1 from users zu where zu.id = ${patientId} and zu.role = 'user' and exists (
          select 1 from group_admins zga where zga.user_id = st.id and zga.group_id <> ${CATALOG_GROUP_ID} and (
            exists (select 1 from survey_access zsa join surveys zs on zs.id = zsa.survey_id
              where zsa.user_id = zu.id and zs.group_id = zga.group_id)
            or exists (select 1 from responses zr join surveys zs on zs.id = zr.survey_id
              where zr.user_id = zu.id and zs.group_id = zga.group_id)
            or exists (select 1 from battery_assignments zba join batteries zb on zb.id = zba.battery_id
              where zba.user_id = zu.id and zb.group_id = zga.group_id)))))
    order by st.email`);
  return [...rows].map((r) => ({ id: String(r.id), email: String(r.email) }));
}

/**
 * Кто из названных людей в зоне ответственности сотрудника.
 *
 * `null` — ограничений нет (суперадмин). Для одного человека и для
 * нескольких (состав группы на карточке) — один запрос к базе сверх чтения
 * групп сотрудника, сколько бы людей ни было в зоне.
 */
export async function patientsInScope(user: User, patientIds: readonly string[]): Promise<Set<string> | null> {
  const inScope = await patientScopeCondition(user);
  if (inScope === null) return null;
  const asked = [...new Set(patientIds)];
  if (!asked.length) return new Set();
  const list = sql.join(
    asked.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await db.execute(
    sql`select x.id from unnest(array[${list}]::text[]) as x(id) where ${inScope(sql`x.id`)}`,
  )) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

/**
 * Отказать, если пациент вне зоны ответственности.
 *
 * Отвечает «не найдено», а не «нельзя»: 403 подтвердил бы, что такой человек
 * в системе есть, — а по коду отказа этого узнавать не следует.
 *
 * Спрашивает только об этом человеке (patientsInScope), а не строит зону.
 */
export async function assertPatientAccess(user: User, patientId: string): Promise<void> {
  const allowed = await patientsInScope(user, [patientId]);
  if (allowed === null) return;
  if (!allowed.has(patientId)) notFound("err.userNotFound");
}
