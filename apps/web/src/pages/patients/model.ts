/**
 * Реестр пациентов (Patients.tsx): чистая часть — что из адреса уходит на
 * сервер, какая вкладка открыта, что стоит на месте таблицы, и как числа и
 * даты читаются в строке.
 *
 * Вынесено ради проверки без браузера (apps/web/test/patientsFilters.test.ts).
 * Все три решения тихие: ошибка в них не роняет экран, а показывает не то —
 * «нікого не знайдено» там, где люди есть, но не доехали, или чужую вкладку
 * по ссылке на свою. Глазом такое замечают, только когда уже поверили.
 */

import type { ClinicalDomain, ScaleNormalization, Severity, UiKey } from "@quizzy/shared";
import { locale as consoleLocale } from "../../format";
import type { Severity as KitSeverity } from "../../ui/primitives";

/* ─────────── реестр 2.0: подання, порядок, страница ─────────── */

/** Подання «Потребує уваги» — так их понимает сервер (patientListQuery.view) */
export type ListView = "risk" | "stale" | "unbooked";
export const LIST_VIEWS: readonly ListView[] = ["risk", "stale", "unbooked"];

/** Порядок реестра; умолчание — «ризик спершу», как на кадре */
export type ListSort = "risk" | "name" | "last" | "next";
export const LIST_SORTS: readonly ListSort[] = ["risk", "name", "last", "next"];
export const DEFAULT_SORT: ListSort = "risk";

/** Чужое значение в адресе — «все», а не отказ сервера */
export function viewOf(raw: string | null): ListView | null {
  return (LIST_VIEWS as readonly string[]).includes(raw ?? "") ? (raw as ListView) : null;
}

export function sortOf(raw: string | null): ListSort {
  return (LIST_SORTS as readonly string[]).includes(raw ?? "") ? (raw as ListSort) : DEFAULT_SORT;
}

/**
 * Строк на странице реестра: на кадре 20. Общий DEFAULT_PER (10) — у
 * сеток и каталога; здесь умолчание своё, и в адресе его нет.
 */
export const REGISTER_PER = 20;
export function registerPer(raw: string | null): number {
  const n = Number(raw);
  return [10, 20, 50, 100].includes(n) ? n : REGISTER_PER;
}

/**
 * Что из адреса уходит на сервер реестра. Пустое не уходит вовсе: `q=` и
 * `view=` сервер читал бы как отбор.
 *
 * «Закріплені за мною» — сужение поверх подання (`lead` — ведущий я), а не
 * другое подання. Прежде чип отправлял `view=mine` вместо выбранной пилюли:
 * на экране горели обе — «з ризиком» и «за мною», — а в списке стояли все
 * мои, в том числе без риска. Сервер пересекает `lead` с зоной и с поданням,
 * и счётчики пилюль считаются уже среди моих.
 */
export function registerQuery(s: {
  q: string;
  group: string | null;
  view: ListView | null;
  mine: boolean;
  /** Кто смотрит: «за мною» — его идентификатор */
  me: string | null;
  sort: ListSort;
  page: number;
  per: number;
}): { q?: string; patientGroup?: string; view?: string; lead?: string; sort: ListSort; limit: number; offset: number } {
  const q = searchOf(s.q);
  return {
    ...(q ? { q } : {}),
    ...(s.group ? { patientGroup: s.group } : {}),
    ...(s.view ? { view: s.view } : {}),
    ...(s.mine && s.me ? { lead: s.me } : {}),
    sort: s.sort,
    limit: s.per,
    offset: (s.page - 1) * s.per,
  };
}

/**
 * Общий кэш динамики и хронологии человека (useResource `key`): шапка
 * справы и её вкладки делят один ответ, а не спрашивают сервер дважды.
 */
export const DYN_KEY = "case-dynamics";
export const TL_KEY = "case-timeline";

/* ─────────── числа и слова ─────────── */

/** Тяжесть сервера (четыре ступени) → пилюля набора (пять; «помірно тяжка» сервер не отдаёт) */
export function kitSeverity(s: Severity | null | undefined): KitSeverity {
  return s ?? "none";
}

/**
 * Число экрана — с десятичной запятой языка консоли: «64,2», а не «64.2»
 * (украинский и русский пишут дробь запятой; английский — точкой). Не
 * больше одного знака после запятой и без разрядных пробелов: баллы шкал
 * — сотни, а не тысячи.
 */
export function shownNumber(v: number, locale: string = consoleLocale()): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, useGrouping: false }).format(v);
}

/** «+2,5», «−16,8», «0» — со знаком минус, а не дефисом, и с запятой языка */
export function signedShown(v: number, locale?: string): string {
  return v > 0 ? `+${shownNumber(v, locale)}` : v < 0 ? `−${shownNumber(Math.abs(v), locale)}` : "0";
}

/**
 * Значение шкалы так, как его читают: доля — процентом, остальное — числом
 * без лишних знаков («14», «64,2»). Единица отдельно: «%» ставится мельче.
 */
export function shownValue(v: number, normalization: ScaleNormalization | null | undefined): { text: string; unit: string } {
  if (normalization === "ratio") return { text: shownNumber(Math.round(v * 100)), unit: "%" };
  return { text: shownNumber(Math.round(v * 10) / 10), unit: "" };
}

/**
 * Ряд значений для «19 → 16 → 14»: в тех же единицах, что и большое число.
 * Числами — для набора (CourseDigits считает по ним ход и сам пишет их
 * дробью языка); строкой — shownSeriesText.
 */
export function shownSeries(values: readonly number[], normalization: ScaleNormalization | null | undefined): number[] {
  return values.map((v) => (normalization === "ratio" ? Math.round(v * 100) : Math.round(v * 10) / 10));
}

/** Тот же ряд словами экрана — с десятичной запятой языка: «64,2 → 61,8» */
export function shownSeriesText(
  values: readonly number[],
  normalization: ScaleNormalization | null | undefined,
  locale?: string,
): string[] {
  return shownSeries(values, normalization).map((v) => shownNumber(v, locale));
}

/**
 * Сдвиг между двумя замерами в единицах экрана: у доли — процентные пункты
 * (0,29 → 0,49 — это «+20 в. п.», а не «+0,2» рядом с «49%»), у прочих —
 * с одним знаком после запятой.
 */
export function shownStep(diff: number, normalization: ScaleNormalization | null | undefined): number {
  return normalization === "ratio" ? Math.round(diff * 100) : Math.round(diff * 10) / 10;
}

/**
 * Порог надёжной зміни в единицах экрана: у доли — процентные пункты вверх
 * до целого; у сырого балла (целые суммы) — вверх до целого: сдвиг на 4
 * при пороге 3,6 надёжен, на 3 — нет, и «поріг 4» говорит ровно это; у
 * нормированных — с одним знаком после запятой.
 */
export function shownLimit(t: number, normalization: ScaleNormalization | null | undefined): number {
  if (normalization === "ratio") return Math.ceil(t * 100 - 1e-9);
  if (!normalization || normalization === "raw") return Math.ceil(t - 1e-9);
  return Math.round(t * 10) / 10;
}

/** Число с десятичной запятой языка консоли: «1,37», «0,969» */
export function fmtNum(v: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(v);
}

/** Первая буква — заглавная: подписи словаря стоят строчными («психіатр»), а в заголовке карточки — с большой */
export function capital(s: string): string {
  return s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s;
}

/** «Шевченко М. В.»: фамилия и инициалы — для пилюль «Кому» */
export function initialsName(full: string): string {
  const [last = "", ...rest] = full.trim().split(/\s+/);
  const init = rest.map((w) => `${w[0]}.`).join(" ");
  return init ? `${last} ${init}` : last;
}

/** «дд.мм» по часам консоли */
export function ddmm(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: "2-digit", month: "2-digit" });
}

/** «ЧЧ:ММ» */
export function hhmm(iso: string, locale: string): string {
  return new Date(iso).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** Сколько календарных дней от момента до «сейчас» (0 — сегодня, 1 — вчера, −1 — завтра) */
export function daysAgo(iso: string, now: number): number {
  const at = new Date(iso);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(new Date(now)) - midnight(at)) / 86_400_000);
}

/**
 * Когда — коротко, как в строке реестра: «сьогодні, 18:00», «завтра,
 * 10:30», иначе «сб 10.10, 10:30». Слова «сьогодні/завтра» — из словаря.
 */
export function whenShort(
  iso: string,
  now: number,
  locale: string,
  words: { today: string; tomorrow: string },
): { text: string; soon: boolean } {
  const d = daysAgo(iso, now);
  const time = hhmm(iso, locale);
  if (d === 0) return { text: `${words.today}, ${time}`, soon: true };
  if (d === -1) return { text: `${words.tomorrow}, ${time}`, soon: true };
  const wd = new Date(iso).toLocaleDateString(locale, { weekday: "short" });
  return { text: `${wd} ${ddmm(iso, locale)}, ${time}`, soon: false };
}

/** Год рождения → «38 р.»: возраст в этом году (день рождения неизвестен — ±1) */
export function ageOf(birthYear: number | null | undefined, now: number): number | null {
  if (!birthYear) return null;
  const age = new Date(now).getFullYear() - birthYear;
  return age > 0 && age < 120 ? age : null;
}

/** Предел поиска на сервере (respondentQuery: search ≤ 120) */
export const SEARCH_MAX = 120;

/**
 * Поиск, как он уходит на сервер: без пробелов по краям и не длиннее предела.
 *
 * Поле ввода длиннее не даст (maxLength), но адрес правят руками и
 * присылают ссылкой, и 121 знак в `?q=` означал отказ сервера (400) на
 * месте всего списка — с кнопкой «повторити», которая повторяла бы тот же
 * отказ. Пробелы по краям сервер срезает и сам; срезаются они и здесь, чтобы
 * пробел, набранный после фамилии, не был новой выборкой и новым запросом.
 */
export function searchOf(raw: string): string {
  return raw.trim().slice(0, SEARCH_MAX).trim();
}

export interface GroupTab<G> {
  /** Открытая группа; null — вкладка «Усі» */
  current: G | null;
  /** Группа в адресе, а список групп ещё не приехал: ждём его, не рисуя «Усі» */
  pending: boolean;
  /**
   * Группа в адресе есть, но среди своих её нет (чужая, удалённая, опечатка).
   * Экран показывает «Усі», и адрес обязан сказать то же: иначе пункт «Усі»
   * в шестерёнке погашен как «уже открыт», снять мёртвый параметр нечем, а
   * «Зберегти відбір» сохраняет вид с группой, которой на экране нет.
   */
  stale: boolean;
}

/**
 * Какая вкладка открыта по адресу.
 *
 * Отказ по списку групп — не повод терять группу из адреса: она, может быть,
 * и своя, просто список не пришёл. Тогда экран — «Усі» со строкой ошибки над
 * ним (как и было), а параметр остаётся: вернётся список — вернётся вкладка.
 */
export function groupTab<G extends { id: string }>(
  groupId: string | null,
  groups: readonly G[] | null,
  groupsError: string | null,
): GroupTab<G> {
  if (!groupId) return { current: null, pending: false, stale: false };
  if (!groups) return { current: null, pending: !groupsError, stale: false };
  const current = groups.find((g) => g.id === groupId) ?? null;
  return { current, pending: false, stale: current === null };
}

/**
 * Что стоит на месте таблицы реестра.
 *
 * «Нікого не знайдено» — только по ответу сервера: пока ответа нет (первая
 * загрузка, обрыв связи — запрос стоит на паузе), это скелет, а отказ —
 * отказ с «повторити». Пусто по отбору (поиск, подання, «за мною»), пусто
 * в группе и пусто вообще — три разных слова: первое зовёт снять отбор,
 * второе — добавить людей в группу, третье — пригласить пациента.
 */
export type RegisterBody = "failed" | "loading" | "noMatch" | "emptyGroup" | "empty" | "rows";

export function registerBody(s: {
  hasData: boolean;
  error: string | null;
  rows: number;
  /** Отбор сужает список: поиск, подання или «закріплені за мною» */
  filtered: boolean;
  /** Открыта вкладка группы */
  group: boolean;
}): RegisterBody {
  if (!s.hasData) return s.error ? "failed" : "loading";
  if (s.rows > 0) return "rows";
  if (s.filtered) return "noMatch";
  return s.group ? "emptyGroup" : "empty";
}

/**
 * Клинический домен словом — строка «Клінічної картини» рабочего места и
 * стан в строке реестра говорят одними словами (shared/domains.ts).
 */
export const CLINICAL_DOMAIN_KEY: Record<ClinicalDomain, UiKey> = {
  suicide: "ws.dom.suicide",
  depression: "ws.dom.depression",
  trauma: "ws.dom.trauma",
  anxiety: "ws.dom.anxiety",
  addiction: "ws.dom.addiction",
  stress: "ws.dom.stress",
  distress: "ws.dom.distress",
  sleep: "ws.dom.sleep",
  cognitive: "ws.dom.cognitive",
  burnout: "ws.dom.burnout",
  wellbeing: "ws.dom.wellbeing",
  personality: "ws.dom.personality",
  other: "ws.dom.other",
};
