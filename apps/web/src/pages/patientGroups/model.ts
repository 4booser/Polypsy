import type { PatientGroupWithCounts } from "@quizzy/shared";

/**
 * Чистая часть экранов групп пациентов: поиск по списку, назначение выборке,
 * пометка «обрана», таблица групп.
 *
 * Вынесено из экранов ради проверки без React и сервера
 * (apps/web/test/patientGroups.test.ts): у этих решений есть граничные
 * случаи — запрос из одних пробелов, отказ посередине выборки, испорченная
 * запись в хранилище браузера, — которые на живом экране воспроизводятся
 * только руками.
 */

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
 * Пометка «обрана група» — закладка читателя на сервере
 * (PUT/DELETE /api/patient-groups/:id/favourite, миграция 0084).
 *
 * Прежде экран держал её в браузере под этим ключом: маршрута не было. Теперь
 * он есть, а отметки, поставленные раньше, переезжают на сервер один раз при
 * открытии списка (`favouritesToMove`) — иначе человек, отметивший пять групп,
 * увидел бы после обновления ни одной.
 */
export const FAVORITES_KEY = "quizzy.patientGroups.favorites";

/** Какие из прежних отметок браузера ещё не стоят на сервере — их переносят */
export function favouritesToMove(local: ReadonlySet<string>, groups: readonly Pick<PatientGroupWithCounts, "id" | "favourite">[]): string[] {
  return groups.filter((g) => local.has(g.id) && !g.favourite).map((g) => g.id);
}

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

/* ─────────── таблица групп ─────────── */

/**
 * Код методики для строки списка: «PHQ-9» из «Депресія (PHQ-9)», «СР-45» из
 * «СР-45. Схильність…». Код у методики — часть названия, отдельного поля
 * нет; где кода в названии нет, строка показывает название целиком (ячейка
 * обрежет его многоточием, а полное — в подсказке).
 */
export function surveyCode(title: string): string {
  /* «(SRQ-20, ВООЗ)» — код до запятой */
  const tail = /\(([A-Z][A-Za-z0-9\- ]{1,14})(?:,[^)]*)?\)\s*$/.exec(title);
  if (tail) return tail[1]!.trim();
  const head = /^([A-ZА-ЯІЇЄҐ][A-ZА-ЯІЇЄҐa-z]{0,6}-\d+[A-Za-z]?)[.:\s]/.exec(title);
  if (head) return head[1]!;
  return title;
}

/** «08.10» — день строки таблицы; год — когда он не текущий */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return d.getFullYear() === now.getFullYear() ? `${dd}.${mm}` : `${dd}.${mm}.${d.getFullYear()}`;
}

export type GroupView = "all" | "fav" | "mine" | "notests";

/** Подходит ли группа под вид таблицы; «веду я» — по владельцу */
export function inGroupView(g: Pick<PatientGroupWithCounts, "favourite" | "ownerId" | "surveyCount">, view: GroupView, me: string | null): boolean {
  if (view === "fav") return g.favourite;
  if (view === "mine") return g.ownerId === me;
  if (view === "notests") return g.surveyCount === 0;
  return true;
}

export type GroupSort = "fav" | "title" | "members" | "risk";

/**
 * Порядок таблицы групп. «Обрані, далі за активністю» — по умолчанию: обрана
 * первой (ради этого её и ставят), затем последняя зміна свежей сверху.
 * Равные — по названию, чтобы строки не прыгали от запроса к запросу.
 */
export function sortGroups<T extends Pick<PatientGroupWithCounts, "favourite" | "changedAt" | "title" | "memberCount" | "riskCount">>(
  groups: readonly T[],
  by: GroupSort,
): T[] {
  const byTitle = (a: T, b: T) => a.title.localeCompare(b.title);
  const cmp: Record<GroupSort, (a: T, b: T) => number> = {
    fav: (a, b) => Number(b.favourite) - Number(a.favourite) || b.changedAt.localeCompare(a.changedAt) || byTitle(a, b),
    title: byTitle,
    members: (a, b) => b.memberCount - a.memberCount || byTitle(a, b),
    risk: (a, b) => b.riskCount - a.riskCount || byTitle(a, b),
  };
  return [...groups].sort(cmp[by]);
}

/**
 * Сводка над таблицей: сколько групп и участников, у скольких ризик и в
 * скольких группах, сколько ещё не прошли назначенное (по группам с
 * методиками). Участник двух групп считается дважды — это места в группах,
 * а не люди, и подпись так и говорит.
 */
export function groupsSummary(groups: readonly Pick<PatientGroupWithCounts, "memberCount" | "riskCount" | "doneCount" | "surveyCount">[]) {
  const withTests = groups.filter((g) => g.surveyCount > 0);
  return {
    groups: groups.length,
    members: groups.reduce((n, g) => n + g.memberCount, 0),
    risk: groups.reduce((n, g) => n + g.riskCount, 0),
    riskGroups: groups.filter((g) => g.riskCount > 0).length,
    assigned: withTests.reduce((n, g) => n + g.memberCount, 0),
    waiting: withTests.reduce((n, g) => n + (g.memberCount - g.doneCount), 0),
  };
}

/** Подстановка в строку словаря: «{n} з {total}» */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/**
 * Форма слова при числе — по правилу языка (Intl.PluralRules): «1 учасник,
 * 3 учасники, 5 учасників». Английскому и дробным хватает «many».
 */
export function pluralOf(n: number, lang: string): "one" | "few" | "many" {
  const cat = new Intl.PluralRules(lang).select(n);
  return cat === "one" ? "one" : cat === "few" ? "few" : "many";
}
