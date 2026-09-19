import { type PatientGroup, type Role, type Sex, type User, roleRank } from "@quizzy/shared";

/**
 * Чистая часть разделов «Лікарі» и «Адміністратори»: кто в каком списке,
 * строка под именем, отбор и страницы.
 *
 * Вынесено из экранов ради проверки без React и сервера
 * (apps/web/test/people.test.ts): правило «кто администратор» — это правило
 * доступа, и разъехаться с лестницей должностей оно должно не молча.
 */

/** Строка справочника сотрудников: то, что нужно списку и карточке */
export interface StaffRow {
  id: string;
  fullName: string;
  firstName: string;
  lastName: string;
  middleName: string | null;
  email: string;
  /** Класс учётной записи: superadmin | admin; пациентов (user) здесь нет */
  role: Role;
  sex: Sex | null;
  birthDate: string | null;
  specialty: string | null;
  unit: string | null;
  /**
   * Коды ролей-шаблонов человека (specialist, head, chief, свои), если они
   * уже загружены. Без них про ступень лестницы сказать нечего.
   */
  ladder?: string[];
}

/** Сотрудник — любая учётная запись не пациента */
export function isStaff(u: Pick<User, "role">): boolean {
  return u.role !== "user";
}

export function fromUser(u: User): StaffRow {
  return {
    id: u.id,
    fullName: u.fullName,
    firstName: u.firstName,
    lastName: u.lastName,
    middleName: u.middleName,
    email: u.email,
    role: u.role,
    sex: u.sex,
    birthDate: u.birthDate,
    specialty: u.specialty,
    unit: u.unit,
  };
}

/**
 * Строка из ответа «кого я вправе назначать» (GET /api/permissions/staff).
 *
 * Тот маршрут отдаёт только имя, почту и класс: заведующему список коллег
 * нужен, а полного реестра ему не положено. Пол и дата рождения остаются
 * пустыми — и на экране их место честно пустует, а не заполняется прочерком,
 * который читался бы как «не указано».
 */
export function fromAssignable(a: { id: string; email: string; role: string; fullName: string }): StaffRow {
  return {
    id: a.id,
    fullName: a.fullName,
    firstName: "",
    lastName: "",
    middleName: null,
    email: a.email,
    role: a.role as Role,
    sex: null,
    birthDate: null,
    specialty: null,
    unit: null,
  };
}

/**
 * Администратор — тот, кому есть кого назначать.
 *
 * Не класс учётной записи: класс admin носит и рядовой специалист, и главный
 * врач. Разница между ними — ступень лестницы (packages/shared/src/permissions.ts,
 * ROLE_LADDER): назначает тот, у кого ступень выше первой, и технический
 * суперадмин, стоящий над лестницей. То же правило, по которому консоль
 * показывает пункт «Права» (App.tsx, canAssign), — второго правила здесь не
 * заводится.
 *
 * Пока роли не загружены (ladder не задан), человек администратором не
 * считается: ошибиться в сторону «не показать» дешевле, чем показать в
 * реестре администраторов того, кто им не является.
 */
export function isAdministrator(row: Pick<StaffRow, "role" | "ladder">): boolean {
  if (row.role === "superadmin") return true;
  return (row.ladder ?? []).some((code) => roleRank(code) > 1);
}

/** Лікарі — все сотрудники, кроме технического суперадмина: он никого не лечит */
export function isDoctor(row: Pick<StaffRow, "role">): boolean {
  return row.role === "admin";
}

/** Поиск по имени и почте, без учёта регистра; пустой запрос — все */
export function matchesQuery(row: Pick<StaffRow, "fullName" | "email">, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return `${row.fullName} ${row.email}`.toLowerCase().includes(needle);
}

/**
 * По алфавиту, а не по дате заведения, как отдаёт сервер: справочник людей
 * читают глазами сверху вниз, и порядок обязан быть предсказуемым.
 */
export function sortByName<T extends { fullName: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.fullName.localeCompare(b.fullName, "uk"));
}

/** Год из даты «ГГГГ-ММ-ДД»; кривая дата — не год, а пусто */
export function birthYear(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const y = Number.parseInt(birthDate.slice(0, 4), 10);
  return Number.isFinite(y) && y > 0 ? y : null;
}

/**
 * Мета-строка под именем: «noga@gmail.com · чол. · 1986р.» — как на кадре,
 * только без телефона и города: телефон сервер наружу не отдаёт, города в
 * модели нет (см. api_gaps). Пустое поле не занимает места, а не печатается
 * прочерком: строка из прочерков ничего не сообщает.
 */
export function metaSegments(
  row: { email: string; sex: Sex | null; birthDate?: string | null; birthYear?: number | null },
  t: { male: string; female: string; year: string },
): string[] {
  const out: string[] = [];
  if (row.email) out.push(row.email);
  if (row.sex === "male") out.push(t.male);
  else if (row.sex === "female") out.push(t.female);
  const year = row.birthYear ?? birthYear(row.birthDate ?? null);
  if (year) out.push(`${year}${t.year}`);
  return out;
}

/**
 * Группы этого лікаря: сервер отдаёт суперадмину все группы, остальным —
 * только свои, поэтому отбор по владельцу нужен ровно суперадмину, а для
 * остальных он ничего не меняет. Поиск — по названию и описанию.
 */
export function ownGroups<T extends Pick<PatientGroup, "ownerId" | "title" | "description">>(
  groups: T[],
  ownerId: string,
  q: string,
): T[] {
  const needle = q.trim().toLowerCase();
  return groups.filter(
    (g) => g.ownerId === ownerId && (!needle || `${g.title} ${g.description ?? ""}`.toLowerCase().includes(needle)),
  );
}

/** Страница списка, посчитанного на клиенте; страница за концом — пустая */
export function pageSlice<T>(items: T[], page: number, per: number): T[] {
  const from = (page - 1) * per;
  return from >= items.length ? [] : items.slice(from, from + per);
}
