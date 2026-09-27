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

/* ─────────── действие над выборкой: по человеку за раз ─────────── */

/**
 * Что уже сделано в этом окне «Призначити тест»: для какого назначения
 * (методика и срок) и кому. Живёт, пока открыто окно, — новое окно
 * начинает с чистого листа (`newProgress`).
 */
export interface EachProgress {
  key: string;
  done: Set<string>;
}

export function newProgress(): EachProgress {
  return { key: "", done: new Set() };
}

export interface EachOutcome {
  /** Скольким из выборки назначение уже выдано — в этой попытке и в прежних */
  done: number;
  total: number;
  /** Отказ, на котором попытка остановилась; null — выдано всем */
  error: unknown;
}

/**
 * Назначение выборке — по запросу на человека (маршрута «пачкой» нет), и
 * отказ может прийти посередине.
 *
 * Раньше цикл просто обрывался: окно показывало текст отказа — и только.
 * Первые трое уже получили методику, остальные пятеро — нет, а экран об
 * этом молчал: специалист не знал, что часть выборки уже назначена, и
 * «Призначити» ещё раз выдавало тем же троим заново (сервер перезаписывает
 * выдачу, но журнал получал по второй записи «назначено» на каждого, а
 * итог — «Тест призначено — 8» — не говорил о первой попытке ничего).
 * Теперь выданное помнится между попытками одного окна: повтор идёт только
 * к тем, кому ещё не выдано, а отказ называет, сколько уже сделано.
 *
 * Смена методики или срока в том же окне — другое назначение: память
 * сбрасывается, и выдаётся всем.
 */
export async function grantEach(
  progress: EachProgress,
  key: string,
  ids: readonly string[],
  act: (id: string) => Promise<unknown>,
): Promise<EachOutcome> {
  if (progress.key !== key) {
    progress.key = key;
    progress.done = new Set();
  }
  const count = () => ids.filter((id) => progress.done.has(id)).length;
  for (const id of ids) {
    if (progress.done.has(id)) continue;
    try {
      await act(id);
    } catch (error) {
      return { done: count(), total: ids.length, error };
    }
    progress.done.add(id);
  }
  return { done: count(), total: ids.length, error: null };
}

/**
 * Текст отказа посередине выборки: причина и сколько уже выдано —
 * «Немає доступу · Тест призначено: 3 з 8». Если не выдано никому,
 * добавлять нечего: причина и есть весь ответ.
 */
export function partialFailure(
  outcome: Pick<EachOutcome, "done" | "total">,
  reason: string,
  words: { done: string; of: string },
): string {
  if (outcome.done === 0) return reason;
  return `${reason} · ${words.done}: ${outcome.done} ${words.of} ${outcome.total}`;
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
