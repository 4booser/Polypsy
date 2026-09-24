/**
 * Чистая часть экранов групп пациентов: строка карточки человека, поиск по
 * списку, выбор чекбоксами, пометка «обрана».
 *
 * Вынесено из экранов ради проверки без React и сервера
 * (apps/web/test/patientGroups.test.ts): у этих решений есть граничные
 * случаи — пустые поля в мета-строке, запрос из одних пробелов, испорченная
 * запись в хранилище браузера, — которые на живом экране воспроизводятся
 * только руками.
 */

/* ─────────── карточка человека ─────────── */

/**
 * Что нужно строке списка. Не `Respondent` и не `PatientGroupMember`: строка
 * одна и та же на вкладке «Усі» (там люди приходят из /api/dynamics/respondents
 * с полом и годом рождения) и на вкладке группы (там — из карточки группы,
 * без них). Требовать полный тип значило бы либо два компонента строки, либо
 * выдумывать пол там, где сервер его не прислал.
 */
export interface PersonLike {
  userId: string;
  fullName: string;
  email: string;
  phone?: string | null;
  unit?: string | null;
  sex?: "male" | "female" | null;
  birthYear?: number | null;
}

/**
 * Мета-строка карточки: «noga@gmail.com · м.Київ · чол. · 1986р.» с макета.
 *
 * Из шести полей макета в системе есть пять: e-mail, телефон, подразделение
 * (на месте города — города у пациента нет вовсе), пол, год рождения.
 * Телефон стоит вторым, как на кадре f05: заказчик решил показывать его в
 * списке «как на макете» (2026-09-25); чтение списка журналируется с
 * пометкой, что телефоны в нём были. Пустые поля пропускаются, а не печатаются прочерком:
 * строка «— · — · 1986р.» читалась бы как поломка, а не как отсутствие.
 */
export function personMeta(
  p: PersonLike,
  words: { male: string; female: string; year: string },
): string[] {
  const out: string[] = [];
  if (p.email) out.push(p.email);
  if (p.phone) out.push(p.phone);
  if (p.unit) out.push(p.unit);
  if (p.sex === "male") out.push(words.male);
  else if (p.sex === "female") out.push(words.female);
  /* «1986р.» — год и суффикс слитно, как на макете */
  if (p.birthYear) out.push(`${p.birthYear}${words.year}`);
  return out;
}

/* ─────────── поиск ─────────── */

/**
 * Совпадает ли запрос хоть с одним из полей. Регистр не важен, пробелы по
 * краям не считаются, пустой запрос совпадает со всем — так поле поиска
 * можно очистить и получить полный список, а не пустой.
 */
export function matchesQuery(q: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

/* ─────────── выбор ─────────── */

/** Новое множество с переключённым элементом: состояние React не правится на месте */
export function toggleIn(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Выбор, очищенный от тех, кого в списке больше нет.
 *
 * Список меняется под выбором: поиск, смена страницы, удаление из группы.
 * Держать в выборе идентификатор, которого на экране нет, значит показывать
 * «3 вибрано» при двух видимых галочках — и отправлять действие человеку,
 * которого специалист не видит.
 */
export function keepPresent(set: ReadonlySet<string>, present: readonly { userId: string }[]): Set<string> {
  const ids = new Set(present.map((p) => p.userId));
  return new Set([...set].filter((id) => ids.has(id)));
}

/* ─────────── «обрана» ─────────── */

/**
 * Пометка «обрана група» живёт в браузере, не на сервере.
 *
 * На сервере признака нет: ни поля у группы, ни таблицы «пользователь ×
 * группа», ни маршрутов поставить/снять. Заводить их с экрана нельзя (см.
 * api_gaps отчёта). Ждать сервера и не рисовать сердце — значит показать
 * заказчику макет без элемента, который на нём есть; рисовать сердце, которое
 * ничего не делает, — хуже, чем не рисовать. Хранилище браузера даёт пометке
 * работать сегодня, с одной оговоркой, названной вслух: она не переезжает за
 * человеком на другой компьютер. Когда маршрут появится, меняются две функции
 * ниже, а экран — нет.
 */
export const FAVORITES_KEY = "quizzy.patientGroups.favorites";

/** Разбор записи из хранилища: всё, что не список строк, — пустая пометка, а не ошибка */
export function parseFavorites(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

export function serializeFavorites(set: ReadonlySet<string>): string {
  return JSON.stringify([...set]);
}
