import type { AlertCase, AlertCaseFacets, AlertCasePage, RiskSeverity } from "@quizzy/shared";

/*
 * Очередь случаев: чистая логика экрана разбора.
 *
 * Здесь всё, что решается без React и без сети: что из адреса уходит в
 * запрос, как строки делятся на разделы, что писать в подзаголовке и в
 * вариантах фильтров. Вынесено ради проверки: на сотнях случаев ошибка в
 * этих местах не видна глазом — строка «прострочено 12» выглядит одинаково
 * правдоподобно и когда она верна, и когда посчитана по странице.
 */

export type CaseStatus = "open" | "resolved" | "all";
export type AssignedFilter = "" | "me" | "none" | "others";

/** Отбор, как он лежит в адресе экрана (useUrlState) */
export interface QueueFilters {
  status: CaseStatus;
  severity: "" | RiskSeverity;
  assigned: AssignedFilter;
  unit: string;
  patientGroup: string;
  patient: string;
  from: string;
  to: string;
  q: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Пределы сервера (routes/alertCases.ts, caseListQuery): подразделение и поиск — до 120 знаков */
const TEXT_MAX = 120;

/** Существующая дата ГГГГ-ММ-ДД — та же проверка, что у сервера (queryDate) */
export function isDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}

/**
 * Отбор из адреса — с приведением к тому, что сервер примет.
 *
 * Сервер на кривое значение отвечает 400, и это правильно: очередь,
 * молча показывающая не то, что просили, опаснее отказа. Но адрес экрана
 * человек правит руками и присылает ссылкой, и из-за одной опечатки в
 * `severity=` экран не должен превращаться в ошибку целиком: неизвестное
 * значение здесь просто не применяется, и поле фильтра это показывает —
 * стоит «будь-яка», а не то, что было в адресе.
 *
 * `all=1` — прежний вид адреса «все, включая разобранные»: он лежит в
 * сохранённых видах (SavedViews хранит строку запроса), и ломать их незачем.
 */
export function readFilters(get: (name: string) => string): QueueFilters {
  const statusRaw = get("status");
  const status: CaseStatus =
    statusRaw === "resolved" || statusRaw === "all" || statusRaw === "open"
      ? statusRaw
      : get("all") === "1"
        ? "all"
        : "open";
  const severity = get("severity");
  const assigned = get("assigned");
  const from = get("from");
  const to = get("to");
  const patient = get("patient");
  const patientGroup = get("patientGroup");
  const unit = get("unit").trim();
  return {
    status,
    severity: severity === "severe" || severity === "moderate" ? severity : "",
    assigned: assigned === "me" || assigned === "none" || assigned === "others" ? assigned : "",
    /*
     * Подразделение длиннее предела сервера не применяется, а не режется:
     * обрезок — это уже другое подразделение, которого нет, а целиком такое
     * значение сервер отвергает (400), и отказ вставал на месте всей очереди.
     */
    unit: unit.length <= TEXT_MAX ? unit : "",
    patientGroup: UUID.test(patientGroup) ? patientGroup : "",
    patient: UUID.test(patient) ? patient : "",
    from: isDay(from) ? from : "",
    // перевёрнутый период не применяется целиком: «с 10-го по 1-е» — это опечатка, а не выборка
    to: isDay(to) && !(isDay(from) && from > to) ? to : "",
    q: get("q").trim().slice(0, TEXT_MAX).trim(),
  };
}

/**
 * Группа пациентов из адреса — только своя.
 *
 * Сервер на чужую, удалённую или выдуманную группу отвечает 404 (как
 * список пациентов: «не найдено», а не «нельзя»), и отказ вставал на месте
 * всей очереди — с «повторити», которое повторяло тот же отказ. Так
 * открывался общий вид коллеги, сохранённый с его группой: у получателя
 * такой группы нет. Когда свои группы известны, чужая не применяется, и
 * поле фильтра это показывает — «усі групи», а не то, что было в адресе;
 * остальной отбор вида остаётся в силе. Очередь при этом становится шире, а
 * не уже: для разбора это безопасная сторона — никто не пропадёт из виду.
 *
 * `own` — null, пока список групп не приехал или не пришёл вовсе: тогда
 * группа применяется как есть. Отказ по списку групп — не повод терять
 * свою группу из отбора; права на группы у разбирающего может и не быть.
 */
export function withOwnGroup(f: QueueFilters, own: readonly string[] | null): QueueFilters {
  if (!f.patientGroup || own === null || own.includes(f.patientGroup)) return f;
  return { ...f, patientGroup: "" };
}

/*
 * Правки адреса очереди. Пустая строка снимает параметр (patchParams в
 * ui/viewParams.ts).
 */

/**
 * Смена статуса. «Відкриті» — умолчание, и в адресе его нет; прежний `all=1`
 * снимается вместе с любой сменой: иначе «Відкриті», выбранные после вида со
 * старым `all=1`, снова читались бы как «Усі».
 */
export function statusPatch(next: CaseStatus): Record<string, string> {
  return { status: next === "open" ? "" : next, all: "" };
}

/**
 * «Скинути фільтри»: весь отбор, кроме статуса. Статус — вкладка, а не
 * сужение: человек, смотревший разобранные, после сброса остаётся на
 * разобранных. Ключи — те же, что проверяет hasNarrowing: кнопка видна
 * ровно тогда, когда ей есть что снять.
 */
export const CLEAR_NARROWING: Readonly<Record<string, string>> = {
  severity: "",
  assigned: "",
  unit: "",
  patientGroup: "",
  patient: "",
  from: "",
  to: "",
  q: "",
};

/** Заголовок пустой очереди: пусто по отбору — не то же, что «открытых нет» */
export function emptyQueueKey(f: QueueFilters): "cases.emptyFiltered" | "cases.emptyOpen" | "cases.emptyAll" {
  if (hasNarrowing(f)) return "cases.emptyFiltered";
  return f.status === "open" ? "cases.emptyOpen" : "cases.emptyAll";
}

/**
 * Параметры запроса очереди.
 *
 * Отбор по человеку всегда идёт списком случаев (`group=case`): строка
 * «человек» уже стоит в очереди, а здесь его случаи раскладываются по
 * одному — чтобы решение принималось о каждом.
 */
export function queueQuery(f: QueueFilters, limit: number, cursor?: string | null): Record<string, string | undefined> {
  return {
    status: f.status,
    group: f.patient ? "case" : undefined,
    severity: f.severity || undefined,
    assigned: f.assigned || undefined,
    unit: f.unit || undefined,
    patientGroup: f.patientGroup || undefined,
    patient: f.patient || undefined,
    from: f.from || undefined,
    to: f.from && f.to && f.from > f.to ? undefined : f.to || undefined,
    search: f.q || undefined,
    limit: String(limit),
    cursor: cursor ?? undefined,
  };
}

/** Задан ли хоть один отбор, кроме статуса: от этого зависит, что писать в пустой очереди */
export function hasNarrowing(f: QueueFilters): boolean {
  return !!(f.severity || f.assigned || f.unit || f.patientGroup || f.patient || f.from || f.to || f.q);
}

/**
 * Строки без повторов.
 *
 * Страницы дописываются к показанным, а очередь живая: между двумя
 * страницами человеку могли дописать сигнал, и его строка переехала
 * выше границы — вторая страница принесла бы его ещё раз. Показывать
 * одного человека дважды — ровно то, от чего группировка и заводилась;
 * остаётся первое появление, то есть более раннее и более срочное место.
 */
export function uniqueRows(items: AlertCase[], grouping: AlertCasePage["grouping"]): AlertCase[] {
  const seen = new Set<string>();
  const out: AlertCase[] = [];
  for (const c of items) {
    const key = grouping === "person" ? c.userId : c.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

export interface QueueSection {
  severity: RiskSeverity;
  /** Сколько строк в разделе по всей выборке — из SQL; null, если счётчиков нет */
  total: number | null;
  items: AlertCase[];
}

/**
 * Разделы очереди по выраженности.
 *
 * Порядок строк уже задан сервером — тяжёлые впереди на всех страницах, —
 * поэтому раздел здесь только подписывается, а не собирается: строки не
 * переставляются. Число у раздела — по всей выборке (facets.sections), а
 * не по тому, что успело загрузиться: «Важкі · 30» при ста сорока тяжёлых
 * — неправда, из-за которой дежурный решит, что тяжёлых он почти разобрал.
 */
export function queueSections(items: AlertCase[], facets: AlertCaseFacets | undefined): QueueSection[] {
  const sections: QueueSection[] = [];
  for (const c of items) {
    const severity: RiskSeverity = c.severity === "severe" ? "severe" : "moderate";
    let last = sections[sections.length - 1];
    if (!last || last.severity !== severity) {
      last = { severity, total: facets ? facets.sections[severity] : null, items: [] };
      sections.push(last);
    }
    last.items.push(c);
  }
  return sections;
}

/** Сколько минут человек ждёт: строка по человеку — с самого раннего его случая */
export function waitingMinutes(c: AlertCase, now: number): number {
  if (!c.group) return c.minutesOpen;
  return Math.max(0, Math.round((now - Date.parse(c.group.oldestOpenedAt)) / 60_000));
}

/** Просрочен ли хоть один случай строки — та же пометка, что в счётчике «прострочено» */
export function rowOverdue(c: AlertCase): boolean {
  return c.group ? c.group.overdue : c.overdue;
}

/** Строк у раздела и в вариантах — ровно те числа, что пришли из SQL */
export function withCount(label: string, n: number | undefined): string {
  return n === undefined ? label : `${label} · ${n}`;
}

/**
 * Подзаголовок: сколько ждёт, сколько просрочено, сколько на мне.
 *
 * Все три — из счётчиков сервера. Прежде «прострочено» и «на мені»
 * считались по загруженной странице: на сотнях случаев экран показывал
 * «прострочено 12», когда их было сто двенадцать.
 */
export function subtitleParts(
  facets: AlertCaseFacets | undefined,
  status: CaseStatus,
  words: { people: string; overdue: string; mine: string; resolved: string; all: string },
): string {
  if (status === "resolved") return words.resolved;
  if (status === "all") return words.all;
  if (!facets) return "";
  const parts = [words.people.replace("{n}", String(facets.total))];
  if (facets.overdue) parts.push(`${words.overdue} ${facets.overdue}`);
  if (facets.assigned.me) parts.push(`${words.mine} ${facets.assigned.me}`);
  return parts.join(" · ");
}
