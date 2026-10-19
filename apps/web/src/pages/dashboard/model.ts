import { ALWAYS_VISIBLE_WIDGETS, DASH_WIDGETS, type DashWidget } from "@quizzy/shared";
import type { BandSpread, ConditionDomain, ConditionSummary, Severity, UiKey, WorkKind } from "@quizzy/shared";
import type { Column, SharePart } from "../../charts/clinical";

/**
 * Чистая логика стартового экрана «Зведення»: ряды по дням и неделям,
 * плитки очереди, доли по ступеням. Без React и без дат «сейчас» внутри —
 * сегодняшний день приходит аргументом, иначе проверка ряда «за 30 днів»
 * зависела бы от дня, в который её запускают (apps/web/test/dashboard.test.ts).
 */

/* ─────────── даты без часовых поясов ─────────── */

/*
 * Дни — строками «YYYY-MM-DD», арифметика — в UTC.
 *
 * Сервер отдаёт ряд уже календарными днями учреждения (to_char по его поясу),
 * и сравнивать их надо как календарные дни, а не как моменты: полночь по
 * местному времени, переведённая в UTC, у Киева — ещё вчера, и столбец
 * сегодняшнего дня съезжал бы на соседний.
 */
const DAY = 86_400_000;
const toUtc = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Календарный день по местному времени — «сегодня» для рядов */
export function localDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

export function addDays(iso: string, n: number): string {
  return fromUtc(toUtc(iso) + n * DAY);
}

/** Понедельник недели, в которую попадает день: неделя режется так же, как date_trunc('week') на сервере */
export function mondayOf(iso: string): string {
  const ms = toUtc(iso);
  const weekday = (new Date(ms).getUTCDay() + 6) % 7; // пн = 0
  return fromUtc(ms - weekday * DAY);
}

/* ─────────── проходження: ряды ─────────── */

export interface DayCount {
  date: string;
  count: number;
}

const tally = (timeline: readonly DayCount[]) => new Map(timeline.map((t) => [t.date, t.count]));

/**
 * Столбцы по дням: последние `days` дней по сегодняшний включительно.
 *
 * Пустые дни приходят нулём, а не выпадают: сервер отдаёт только дни, когда
 * кто-то сдавал, и без заполнения ряд из двадцати столбцов за тридцать
 * дней сжимал бы время — выходные просто исчезали бы.
 */
export function dailyColumns(
  timeline: readonly DayCount[],
  days: number,
  today: string,
  label: (iso: string) => string,
): Column[] {
  const byDay = tally(timeline);
  const out: Column[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    out.push({ key: d, label: label(d), value: byDay.get(d) ?? 0 });
  }
  return out;
}

/** Сумма по неделям: понедельник → число */
function weeklyTotals(timeline: readonly DayCount[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of timeline) {
    const w = mondayOf(t.date);
    out.set(w, (out.get(w) ?? 0) + t.count);
  }
  return out;
}

/**
 * Столбцы по неделям: `weeks` недель, последняя — текущая (неполная).
 * Подпись — понедельник: «неделя с 7 вер» однозначна, номер недели — нет.
 */
export function weeklyColumns(
  timeline: readonly DayCount[],
  weeks: number,
  today: string,
  label: (iso: string) => string,
): Column[] {
  const byWeek = weeklyTotals(timeline);
  const current = mondayOf(today);
  const out: Column[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const w = addDays(current, -7 * i);
    out.push({ key: w, label: label(w), value: byWeek.get(w) ?? 0 });
  }
  return out;
}

/**
 * Итог окна и такого же окна перед ним.
 *
 * Сравнение с предыдущим окном той же длины, а не с «прошлым месяцем»: у
 * месяцев разное число дней и выходных, и февраль всегда выглядел бы спадом.
 */
export function periodTotals(timeline: readonly DayCount[], days: number, today: string): { current: number; previous: number } {
  const from = addDays(today, -(days - 1));
  const prevFrom = addDays(from, -days);
  let current = 0;
  let previous = 0;
  for (const t of timeline) {
    if (t.date >= from && t.date <= today) current += t.count;
    else if (t.date >= prevFrom && t.date < from) previous += t.count;
  }
  return { current, previous };
}

/* ─────────── очередь: плитки ─────────── */

/*
 * Виды работы, у которых число само по себе — просрочка: «прострочений
 * облік», «прострочені повтори», «прострочені призначення». Только их плитка
 * красится янтарём. Неявки, непрочитанные и направления — объём работы,
 * а не нарушение срока, и внимания цветом не требуют.
 */
export const OVERDUE_KINDS: ReadonlySet<WorkKind> = new Set<WorkKind>(["dispensary", "followup", "assignment"]);

/**
 * Названия видов работы для плиток.
 *
 * Перебор полный: новый вид работы не соберётся, пока ему не дадут имени —
 * так же, как в самой очереди. Именно на этом однажды и попались: счётчики
 * там перечислялись поимённо и отстали от списка видов.
 */
export const WORK_KIND: Record<WorkKind, UiKey> = {
  noshow: "work.filterNoshows",
  message: "work.filterMessages",
  dispensary: "work.filterDispensary",
  followup: "work.filterFollowups",
  referral: "work.filterReferrals",
  assignment: "work.filterAssignments",
};

export interface WorkTile {
  kind: WorkKind;
  count: number;
  attention: boolean;
}

/**
 * Плитки очереди: только непустые виды.
 *
 * Плитка с нулём — место, куда нажимают и попадают в пустоту. Янтарь — только
 * у просроченных и только когда их больше нуля: нулевая просрочка ничего не
 * требует, и янтарный ноль приучил бы не замечать янтарь вовсе.
 */
export function workTiles(byKind: Partial<Record<WorkKind, number>> | undefined): WorkTile[] {
  return (Object.keys(WORK_KIND) as WorkKind[])
    .map((kind) => ({ kind, count: byKind?.[kind] ?? 0 }))
    .filter((t) => t.count > 0)
    .map((t) => ({ ...t, attention: OVERDUE_KINDS.has(t.kind) && t.count > 0 }));
}

/* ─────────── стан пацієнтів ─────────── */

export const DOMAIN_KEY: Record<ConditionDomain, UiKey> = {
  depression: "dash.dom.depression",
  anxiety: "dash.dom.anxiety",
  stress: "dash.dom.stress",
  ptsd: "dash.dom.ptsd",
  wellbeing: "dash.dom.wellbeing",
  burnout: "dash.dom.burnout",
  alcohol: "dash.dom.alcohol",
};

/**
 * Что блок направления может сказать о доле.
 *
 *   few      — людей меньше порога: никаких чисел, только слова;
 *   noBands  — у методик направления нет полос (PSS-10, DASS-42): доли нет,
 *              и это не скрытие, а отсутствие шкалы, к которой относить;
 *   hidden   — полосы есть, но малая ячейка прячет долю;
 *   shown    — доля показана.
 */
export type ShareState = "few" | "noBands" | "hidden" | "shown";

export function shareState(spread: BandSpread, people: number | null): ShareState {
  if (people === null || spread.banded === null) return "few";
  if (spread.banded === 0) return "noBands";
  return spread.clinical.percent === null ? "hidden" : "shown";
}

export interface BandLabels {
  severity: Record<Severity, string>;
  /** «Норма або легка» — пара, показанная одной частью */
  low: string;
  /** «Помірна або виражена» */
  high: string;
}

/**
 * Части полосы долей из раскладки сервера.
 *
 * Сервер прячет ступени ПАРАМИ внутри половины (норма/легка и
 * помірна/виражена), а сумма половины при этом известна: клинических — из
 * доли, остальных — вычитанием из числа людей. Поэтому скрытая пара
 * рисуется одной частью с общим названием — и полоса остаётся целой. Без
 * этого ShareBar выбросил бы скрытое из целого, и «норма» заняла бы в
 * полосе больше места, чем у неё есть на самом деле.
 */
export function spreadParts(spread: BandSpread, labels: BandLabels): SharePart[] {
  if (spread.banded === null || spread.banded === 0 || spread.clinical.count === null) return [];
  const high = spread.clinical.count;
  const low = spread.banded - high;
  const b = spread.bands;
  const half = (a: Severity, c: Severity, sum: number, merged: string, tone: Severity): SharePart[] =>
    b[a] !== null && b[c] !== null
      ? [
          { key: a, label: labels.severity[a], value: b[a], severity: a },
          { key: c, label: labels.severity[c], value: b[c], severity: c },
        ]
      : [{ key: `${a}-${c}`, label: merged, value: sum, severity: tone }];
  /*
   * Слитой паре — тон её старшей ступени: «помірна або виражена» красится как
   * помірна, «норма або легка» — как легка. Не нижней: пара, в которой есть
   * легкие, выкрашенная «нормой», обещала бы больше спокойствия, чем есть.
   */
  return [...half("none", "mild", low, labels.low, "mild"), ...half("moderate", "severe", high, labels.high, "moderate")];
}

/**
 * Ход среднего по неделям для линии: только посчитанные недели.
 *
 * Неделя под порогом приходит null. Линия без оси всё равно не показывает
 * время честно, а ноль вместо пропуска нарисовал бы провал, которого не
 * было, — поэтому пропуски выбрасываются, и в подписи сказано, что
 * выброшены.
 */
export function sparkValues(weeks: ConditionSummary["weeks"]): number[] {
  return weeks.map((w) => w.meanPercent).filter((v): v is number => v !== null && Number.isFinite(v));
}

/** «{n}» → число: подстановка в строку словаря */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/**
 * Форма строки словаря по числу: «1 сесія», «3 сесії», «5 сесій».
 *
 * Формы — через «|», в порядке категорий Intl.PluralRules: украинский и
 * русский — one|few|many|other, английский — one|other (тот же порядок, что
 * у people/parts.tsx, plural). Форма возвращается с подстановками как есть:
 * число, по которому она выбрана, не обязано быть {n} — у «0 з 1 входу»
 * форма идёт по {of}. Строка без «|» возвращается целиком.
 */
export function byCount(template: string, n: number, lang: string): string {
  const forms = template.split("|");
  const order = lang === "en" ? ["one", "other"] : ["one", "few", "many", "other"];
  const at = order.indexOf(new Intl.PluralRules(lang).select(n));
  return forms[Math.min(at < 0 ? forms.length - 1 : at, forms.length - 1)] ?? template;
}

/** Число со словом в нужной форме: byCount и {n} — тем же числом */
export function withCount(template: string, n: number, lang: string): string {
  return fill(byCount(template, n, lang), { n });
}

/* ─────────── віджети: порядок и выключенные ─────────── */

/*
 * Колонка віджета на экране — по его природе, а не по порядку: широкие
 * (графики, шкала дня) — в главной колонке, списки — в боковой, таблица
 * направлений — во всю ширину. Порядок из настройки действует внутри колонки.
 */
export const WIDGET_COLUMN: Record<DashWidget, "main" | "side" | "full"> = {
  cases: "main",
  day: "main",
  passes: "main",
  missed: "side",
  work: "side",
  collect: "side",
  conditions: "full",
};

export interface WidgetLayout {
  order: DashWidget[];
  hidden: Set<DashWidget>;
}

const isWidget = (k: string): k is DashWidget => (DASH_WIDGETS as readonly string[]).includes(k);

/**
 * Порядок и выключенные из профиля. Незнакомые ключи (профиль новее консоли)
 * молча пропускаются, новые віджети встают в конец своим порядком по
 * умолчанию, а случаи риска не выключаются, что бы ни пришло.
 */
export function widgetLayout(prefs: { order?: string[]; hidden?: string[] } | null | undefined): WidgetLayout {
  const seen = new Set<DashWidget>();
  const order: DashWidget[] = [];
  for (const k of [...(prefs?.order ?? []), ...DASH_WIDGETS]) {
    if (isWidget(k) && !seen.has(k)) {
      seen.add(k);
      order.push(k);
    }
  }
  const hidden = new Set<DashWidget>(
    (prefs?.hidden ?? []).filter(isWidget).filter((k) => !(ALWAYS_VISIBLE_WIDGETS as readonly string[]).includes(k)),
  );
  return { order, hidden };
}

/**
 * Сохранение настроек по очереди, последним словом.
 *
 * Ящик «Налаштувати зведення» применяет правку сразу и шлёт её в профиль.
 * Через useAction второе сохранение, пришедшее, пока первое в пути,
 * молча отбрасывалось (run не начинает второе действие): два щелчка по
 * переключателям или Alt+↓ дважды подряд — и на экране одно, а в профиле
 * прежнее, и на другой машине зведення собиралось не так, как его настроили.
 *
 * Здесь пришедшее в полёте копится и уходит следом, одним запросом: правка
 * віджетів несёт порядок и выключенные целиком, поэтому последняя —
 * правда, и промежуточные слать незачем. Отказ одной не останавливает
 * следующие; `idle` — когда всё отправлено (перечитать профиль).
 */
export function saveQueue<P extends object>(
  send: (patch: P) => Promise<unknown>,
  hooks: { failed?: (error: unknown) => void; idle?: () => void } = {},
): (patch: P) => Promise<void> {
  let next: P | null = null;
  let running: Promise<void> | null = null;
  const drain = async () => {
    while (next) {
      const patch = next;
      next = null;
      try {
        await send(patch);
      } catch (e) {
        hooks.failed?.(e);
      }
    }
    running = null;
    hooks.idle?.();
  };
  return (patch: P) => {
    next = { ...(next ?? {}), ...patch } as P;
    if (!running) running = drain();
    return running;
  };
}

/** Сдвиг віджета на одно место (Alt ↑ / Alt ↓) */
export function moveWidget(order: readonly DashWidget[], key: DashWidget, dir: -1 | 1): DashWidget[] {
  const at = order.indexOf(key);
  const to = at + dir;
  if (at === -1 || to < 0 || to >= order.length) return [...order];
  const next = [...order];
  [next[at], next[to]] = [next[to]!, next[at]!];
  return next;
}

/** Віджет на место другого (перетаскивание): остальные сдвигаются */
export function dropWidget(order: readonly DashWidget[], key: DashWidget, onto: DashWidget): DashWidget[] {
  if (key === onto) return [...order];
  const from = order.indexOf(key);
  const to = order.indexOf(onto);
  if (from === -1 || to === -1) return [...order];
  const rest = order.filter((k) => k !== key);
  const at = rest.indexOf(onto);
  rest.splice(from < to ? at + 1 : at, 0, key);
  return rest;
}

/* ─────────── проходження: столбцы и сводка ─────────── */

export type PassRange = "30d" | "90d" | "12w";

export interface PassColumn {
  key: string;
  /** Подпись под столбцом и в подсказке */
  label: string;
  value: number;
  /** Суббота или воскресенье: другой ритм, другой тон */
  weekend?: boolean;
  /** Сегодняшний день или текущая неделя */
  current?: boolean;
  /** Неделя ещё идёт */
  partial?: boolean;
}

/** День недели календарного дня: пн = 0 … нд = 6 */
export function weekdayOf(iso: string): number {
  return (new Date(toUtc(iso)).getUTCDay() + 6) % 7;
}

/**
 * Столбцы окна и средняя линия: по дням — средний день предыдущего такого же
 * окна, по неделям — средняя неделя предыдущих двенадцати. Сравнение с
 * окном той же длины, а не с «прошлым месяцем»: у месяцев разное число
 * выходных.
 */
export function passColumns(
  timeline: readonly DayCount[],
  range: PassRange,
  today: string,
  label: (iso: string) => string,
): { columns: PassColumn[]; mean: number | null } {
  if (range === "12w") {
    const weeks = weeklyColumns(timeline, 24, today, label);
    const cur = weeks.slice(12);
    const prevSum = weeks.slice(0, 12).reduce((n, c) => n + c.value, 0);
    return {
      columns: cur.map((c, i) => ({ ...c, current: i === cur.length - 1, partial: i === cur.length - 1 })),
      mean: prevSum > 0 ? prevSum / 12 : null,
    };
  }
  const days = range === "30d" ? 30 : 90;
  const cols = dailyColumns(timeline, days * 2, today, label);
  const cur = cols.slice(days);
  const prevSum = cols.slice(0, days).reduce((n, c) => n + c.value, 0);
  return {
    columns: cur.map((c, i) => ({ ...c, weekend: weekdayOf(c.key) >= 5, current: i === cur.length - 1 })),
    mean: prevSum > 0 ? prevSum / days : null,
  };
}

export interface PassSummary {
  current: number;
  previous: number;
  /** Изменение к предыдущему окну, проценты; null — сравнивать не с чем */
  changePct: number | null;
  /** Средний будний день окна; null — будних дней нет */
  weekdayMean: number | null;
  today: number;
  /** Тот же день недели неделей раньше */
  weekAgo: number;
}

export function passSummary(timeline: readonly DayCount[], days: number, today: string): PassSummary {
  const { current, previous } = periodTotals(timeline, days, today);
  const byDay = tally(timeline);
  let weekdays = 0;
  let weekdaySum = 0;
  for (let i = days - 1; i >= 0; i--) {
    const d = addDays(today, -i);
    if (weekdayOf(d) < 5) {
      weekdays++;
      weekdaySum += byDay.get(d) ?? 0;
    }
  }
  return {
    current,
    previous,
    changePct: previous > 0 ? Math.round(((current - previous) / previous) * 100) : null,
    weekdayMean: weekdays ? Math.round((weekdaySum / weekdays) * 10) / 10 : null,
    today: byDay.get(today) ?? 0,
    weekAgo: byDay.get(addDays(today, -7)) ?? 0,
  };
}

/** Сдвиг среднего за окно в процентных пунктах: последняя посчитанная неделя минус первая */
export function meanShift(weeks: ConditionSummary["weeks"]): number | null {
  const v = sparkValues(weeks);
  return v.length > 1 ? Math.round(v[v.length - 1]! - v[0]!) : null;
}
