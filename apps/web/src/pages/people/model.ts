import {
  type AssignableStaff,
  type PatientGroup,
  type Role,
  type Sex,
  type StaffDirectoryUser,
  type User,
  normalizePhone,
  roleRank,
} from "@quizzy/shared";

/**
 * Чистая часть разделов «Лікарі» и «Адміністратори»: кто в каком списке,
 * строка под именем, поиск, отбор, группы и страницы.
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
  /** Подразделение из анкеты; карточка подписывает его «Організація» */
  unit: string | null;
  /**
   * Відділення — из профиля приёма (справочник отделений), а не из анкеты.
   * Почему так и чем подменяется, когда профиля нет, — см. workplaceOf.
   */
  department: string | null;
  /** Посада: из профиля приёма, а без него — из анкеты (см. fromUser) */
  position: string | null;
  /**
   * Телефон — расшифрованный сервером, только из справочника
   * (`?directory=1`): чтение такого ответа сервер пишет в журнал с пометкой
   * `phones`. Своя карточка берётся из профиля, и там его нет.
   */
  phone: string | null;
  /**
   * Коды ролей-шаблонов человека (specialist, head, chief, свои), если они
   * уже загружены. Без них про ступень лестницы сказать нечего.
   */
  ladder?: string[];
}

/** Пустая строка и строка из пробелов — не значение: иначе «» стала бы группой */
function clean(v: string | null | undefined): string | null {
  const s = v?.trim();
  return s ? s : null;
}

/** Сотрудник — любая учётная запись не пациента */
export function isStaff(u: Pick<User, "role">): boolean {
  return u.role !== "user";
}

/**
 * Строка из учётной записи — справочника (с телефоном и профилем приёма) или
 * своего профиля (без них).
 *
 * Посада берётся из профиля приёма, а анкетная — запасная: в профиле она
 * стоит рядом с отделением и по ней работает запись на приём, то есть это
 * та должность, под которой человек действительно принимает. Анкетная
 * заполняется от руки и у сотрудника чаще пуста.
 */
export function fromUser(u: User | StaffDirectoryUser): StaffRow {
  const placement = "placement" in u ? u.placement : null;
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
    unit: clean(u.unit),
    department: clean(placement?.department),
    position: clean(placement?.position) ?? clean(u.position),
    phone: "phone" in u ? clean(u.phone) : null,
  };
}

/**
 * Строка из ответа «кого я вправе назначать» (GET /api/permissions/staff).
 *
 * Тот маршрут отдаёт имя, почту, класс и рабочие сведения — подразделение,
 * посаду, а в режиме справочника ещё профиль приёма и телефон; анкеты (пола,
 * даты рождения) в нём нет: заведующему список коллег нужен, а полного
 * реестра ему не положено. Пол и дата рождения остаются пустыми — и на
 * экране их место честно пустует, а не заполняется прочерком, который
 * читался бы как «не указано».
 */
export function fromAssignable(a: AssignableStaff): StaffRow {
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
    unit: clean(a.unit),
    department: clean(a.placement?.department),
    position: clean(a.placement?.position) ?? clean(a.position),
    phone: clean(a.phone),
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

/* ─────────── поиск ─────────── */

/**
 * Апостроф украинского имени набирают тремя знаками: ’ (типографский, так
 * его ставит раскладка), ' (машинный) и ʼ (буквенный, рекомендованный
 * правописанием). «Мар'яна» в поле поиска обязана находить «Мар’яну» в
 * справочнике — иначе человек, набравший имя правильно, получает «нікого не
 * знайдено» и решает, что коллеги нет.
 */
function fold(s: string): string {
  /* кодами, а не знаками: ʼ и ´ вне подмножества шрифтов, и сторож шрифтов (fontCoverage) читает исходник */
  return s.toLowerCase().replace(/[\u2019\u02bc\u0060\u00b4]/g, "'");
}

/** Похоже ли слово запроса на номер или его кусок: цифры и то, чем их разделяют */
const PHONE_LIKE = /^[\d\s()+\-.]+$/;

/**
 * Совпадает ли номер с запросом — целиком или куском.
 *
 * Номер целиком (запрос нормализуется, см. normalizePhone) сравнивается на
 * равенство по той же нормализации, по которой сервер считает слепой индекс:
 * «050 111 22 33», «+38 (050) 111-22-33» и «80501112233» — один номер здесь
 * так же, как при проверке «номер уже используется». Кусок номера — от трёх
 * цифр — ищется подстрокой и в международной записи (380501112233), и в
 * привычной внутренней (0501112233): «050111» набирают чаще, чем «38050111».
 *
 * Меньше трёх цифр — не поиск по номеру: «5» нашлось бы почти у каждого, и
 * отбор по одной цифре выглядел бы как поломка поиска.
 */
export function phoneMatches(phone: string | null | undefined, q: string): boolean {
  if (!phone || !PHONE_LIKE.test(q)) return false;
  const digits = q.replace(/\D/g, "");
  if (digits.length < 3) return false;
  const stored = normalizePhone(phone);
  const whole = normalizePhone(q);
  if (stored && whole) return stored === whole;
  /* номер, который не нормализуется (старая запись), сравнивается просто цифрами */
  const intl = stored ? stored.slice(1) : phone.replace(/\D/g, "");
  const national = intl.startsWith("380") ? `0${intl.slice(3)}` : intl;
  return intl.includes(digits) || national.includes(digits);
}

/**
 * Поиск раздела: по имени, логину (почте) и телефону; пустой запрос — все.
 *
 * ФИО — в любом порядке слов: «Іван Петренко» находит «Петренко Іван
 * Іванович». Справочник печатает фамилию первой, а человек набирает, как
 * называет коллегу вслух, — имя первым. Каждое слово запроса обязано
 * найтись в имени, почте или номере; слово, не нашедшееся нигде, отсекает
 * строку, иначе «Іван Коваль» показывал бы всех Иванов.
 *
 * Номер, набранный с пробелами («067 123 45 67»), сначала пробуется целиком:
 * по словам его куски в две цифры короче порога и ничего бы не нашли.
 *
 * Ищется по расшифрованному — как список пациентов (routes/patients.ts):
 * слепой индекс телефона умеет только «номер целиком равен», а куска номера
 * по отпечатку не найти. Номера здесь и так в ответе (сервер отдаёт их
 * справочнику и пишет это в журнал), поэтому второго пути к ним поиск не
 * открывает.
 */
export function matchesQuery(row: Pick<StaffRow, "fullName" | "email"> & { phone?: string | null }, q: string): boolean {
  const needle = fold(q.trim());
  if (!needle) return true;
  if (phoneMatches(row.phone, needle)) return true;
  const text = fold(`${row.fullName} ${row.email}`);
  return needle.split(/\s+/).every((word) => text.includes(word) || phoneMatches(row.phone, word));
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
 * Мета-строка под именем в карточке человека (списки пациентов и лікарів под
 * карточкой, кадры f04/f30/f50): «noga@gmail.com · чол. · 1986р.» — как на
 * кадре, только без телефона и города: города в модели нет (см. api_gaps).
 * Пустое поле не занимает места, а не печатается прочерком: строка из
 * прочерков ничего не сообщает.
 *
 * Список раздела «Лікарі» печатает свою строку — staffMeta ниже: там состав
 * задан решением заказчика 2026-09-26, а у карточки — кадрами.
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
 * Відділення человека — ось отбора и группировки «Підрозділ/відділення».
 *
 * Сначала профиль приёма: отделение там выбрано из справочника, и у коллег
 * одного отделения пишется одинаково. Без профиля — подразделение из анкеты:
 * учреждение, которое не ведёт расписание приёма, иначе получило бы список,
 * где все до одного «без відділення», и сортировка по отделениям, о которой
 * просил заказчик, не показывала бы ничего. Смешения двух понятий здесь нет:
 * оба отвечают на один вопрос — «где человек работает», — и профиль, когда
 * он есть, главнее.
 */
export function workplaceOf(row: Pick<StaffRow, "department" | "unit">): string | null {
  return clean(row.department) ?? clean(row.unit);
}

/**
 * Строка под именем в списке «Лікарі» / «Адміністратори».
 *
 * Состав и порядок — решение заказчика 2026-09-26: «логін · телефон ·
 * відділення · посада». Кадр f42 рисовал «пошта · телефон · місто · стать ·
 * рік»; города в модели нет, а стать и рік оставлены в конце, как на кадре:
 * заказчик просил добавить рабочие сведения, а не убрать анкету, — и пол
 * лікаря в психологическом отделении не праздная подробность (пациенты
 * нередко просят специалиста своего пола).
 *
 * `omit` убирает то, по чему список сейчас сгруппирован: под заголовком
 * «Психологічне відділення» печатать то же слово в каждой строке — значит
 * удлинять строку повтором и сталкивать настоящие различия на вторую строку.
 *
 * Пустое поле не печатается вовсе — ни пустым местом, ни лишней точкой между
 * соседями: разделитель ставит разметка между частями, а частей ровно
 * столько, сколько значений.
 */
export function staffMeta(
  row: Pick<StaffRow, "email" | "phone" | "department" | "unit" | "position" | "sex" | "birthDate">,
  t: { male: string; female: string; year: string },
  omit?: StaffGroupBy,
): string[] {
  const out: string[] = [];
  if (row.email) out.push(row.email);
  if (row.phone) out.push(row.phone);
  const place = workplaceOf(row);
  if (place && omit !== "unit") out.push(place);
  if (row.position && omit !== "position") out.push(row.position);
  if (row.sex === "male") out.push(t.male);
  else if (row.sex === "female") out.push(t.female);
  const year = birthYear(row.birthDate);
  if (year) out.push(`${year}${t.year}`);
  return out;
}

/* ─────────── отбор, порядок и группы ─────────── */

export type StaffGroupBy = "unit" | "position";
export type StaffSort = "name" | StaffGroupBy;

/** Порядок из адреса; незнакомое значение (старая или испорченная ссылка) — по имени */
export function parseSort(v: string | null | undefined): StaffSort {
  return v === "unit" || v === "position" ? v : "name";
}

function valueOf(row: Pick<StaffRow, "department" | "unit" | "position">, by: StaffGroupBy): string | null {
  return by === "unit" ? workplaceOf(row) : clean(row.position);
}

/**
 * Ключ сравнения значения: без регистра и лишних пробелов.
 *
 * Посада в анкете набирается от руки, и «Психолог», «психолог» и
 * «Психолог » — одна должность. Без свёртки они стали бы тремя группами и
 * тремя пунктами выпадающего фильтра, и выбор одного показывал бы треть
 * психологов.
 */
function keyOf(v: string): string {
  return v.trim().replace(/\s+/g, " ").toLocaleLowerCase("uk");
}

/**
 * Значения выпадающего фильтра — из самих данных списка, по алфавиту.
 *
 * Считаются по всему списку раздела, а не по уже отобранному: иначе выбор
 * відділення выкидывал бы из фильтра посад всё, чего в нём нет, и вернуться
 * к полному набору можно было бы, только сбросив первый фильтр. Одно значение
 * в разных написаниях (см. keyOf) — один пункт, подписанный так, как оно
 * встретилось первым по алфавиту имён.
 */
export function facetValues(rows: Pick<StaffRow, "fullName" | "department" | "unit" | "position">[], by: StaffGroupBy): string[] {
  const seen = new Map<string, string>();
  for (const r of sortByName(rows)) {
    const v = valueOf(r, by);
    if (v && !seen.has(keyOf(v))) seen.set(keyOf(v), v);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "uk"));
}

/**
 * Выбранное значение фильтра против пунктов списка.
 *
 * Значение приходит из адреса, а там оно может быть написано иначе, чем
 * пункт («психолог» против «Психолог») или не встречаться в данных вовсе
 * (ссылку переслали, а человека с тех пор перевели). В первом случае поле
 * показывает пункт списка — отбор и так сравнивает без регистра (keyOf); во
 * втором значение остаётся отдельным пунктом: иначе поле показывало бы
 * «Усі», а список — пустоту, и понять, откуда она, было бы нечем.
 */
export function facetChoice(values: string[], current: string): { value: string; options: string[] } {
  if (!current.trim()) return { value: "", options: values };
  const hit = values.find((v) => keyOf(v) === keyOf(current));
  return hit ? { value: hit, options: values } : { value: current, options: [...values, current] };
}

/** Отбор по всем трём полям разом: поиск, відділення, посада; пустое поле — не отбор */
export function filterStaff<T extends StaffRow>(rows: T[], f: { q: string; unit: string; position: string }): T[] {
  const unit = f.unit.trim() ? keyOf(f.unit) : null;
  const position = f.position.trim() ? keyOf(f.position) : null;
  return rows.filter((r) => {
    if (unit !== null) {
      const v = valueOf(r, "unit");
      if (!v || keyOf(v) !== unit) return false;
    }
    if (position !== null) {
      const v = valueOf(r, "position");
      if (!v || keyOf(v) !== position) return false;
    }
    return matchesQuery(r, f.q);
  });
}

/** Группа списка: подпись (null — «без відділення» / «без посади») и люди в ней по алфавиту */
export interface StaffGroup<T> {
  title: string | null;
  rows: T[];
}

/**
 * Группы при сортировке по відділенню или посаді.
 *
 * Группы — по алфавиту, люди внутри — по имени. «Без відділення» / «без
 * посади» — последней группой, а не первой, как вышло бы у пустой строки при
 * сортировке: это остаток, а не раздел, и открывать им список значило бы
 * начинать с того, чего не знаем. Пустых групп не бывает — группа рождается
 * первым своим человеком.
 */
export function groupStaff<T extends StaffRow>(rows: T[], by: StaffGroupBy): StaffGroup<T>[] {
  const groups = new Map<string | null, StaffGroup<T>>();
  for (const r of sortByName(rows)) {
    const v = valueOf(r, by);
    const k = v ? keyOf(v) : null;
    const g = groups.get(k);
    if (g) g.rows.push(r);
    else groups.set(k, { title: v, rows: [r] });
  }
  return [...groups.values()].sort((a, b) =>
    a.title === null ? 1 : b.title === null ? -1 : a.title.localeCompare(b.title, "uk"),
  );
}

/**
 * Какие из двух списков человеку открыты.
 *
 * Одно правило на маршруты (App.tsx) и на вкладки «Лікарі | Адміністратори»
 * над списком: вкладка, ведущая на адрес, которого у человека нет, увела бы
 * его на сводку молча — общий перехват маршрутов не падает. Сегодня оба
 * списка открыты одним и тем же — суперадмину и тому, кому есть кого
 * назначать (ступень выше первой; см. App.tsx и пункт «Права» в Rail.tsx), —
 * но разводятся они здесь по отдельности: разведёт их правка одной строки,
 * и вкладки подстроятся сами.
 */
export function peopleLists(user: { role?: string | null; ladderRank?: number | null } | null | undefined): {
  doctors: boolean;
  admins: boolean;
} {
  const assigns = user?.role === "superadmin" || (user?.ladderRank ?? 0) > 1;
  return { doctors: assigns, admins: assigns };
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

/**
 * Чем подписана карточка человека — словом роли или его именем.
 *
 * Правило сводит все восемь кадров карточки (f04, f30, f31, f34, f35, f40,
 * f43, f47, f50) и разбирается здесь, а не в разметке: «имя или роль» — это
 * то, что видит и человек, и история браузера, и заголовок окна, а глазами
 * такое ловится только случайно.
 *
 *   общая консоль: своя — «Лікар» (f04 у специалиста, f30 у заведующего),
 *                  чужая — ПІБ (f31, f34, f35), то есть null;
 *   раздел людей:  своя и чужая — слово роли, и какое, говорит справочник,
 *                  из которого карточка открыта: суперадмін ведёт
 *                  администраторов (f47 своя, f50 чужая), администратор —
 *                  лікарів (f40 своя, f43 чужая).
 */
export function cardTitleRole(
  kind: "specialist" | "admin" | "peopleStaff" | "peopleAdmins",
  me: boolean,
): "ppl.roleDoctor" | "ppl.roleAdmin" | "ppl.roleSuperTitle" | null {
  if (kind === "peopleAdmins") return me ? "ppl.roleSuperTitle" : "ppl.roleAdmin";
  if (kind === "peopleStaff") return me ? "ppl.roleAdmin" : "ppl.roleDoctor";
  return me ? "ppl.roleDoctor" : null;
}
