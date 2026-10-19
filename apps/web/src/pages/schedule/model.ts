/**
 * Расписание специалиста — что форма недели и форма исключения
 * отправляют и когда.
 *
 * Сервер проверяет то же самое (scheduleTemplateSchema и
 * scheduleExceptionSchema в packages/shared/src/schemas.ts), но его отказ —
 * строка разбора тела, адресованная разработчику: «endsAt: интервал не может
 * кончаться раньше, чем начался», по-русски на любом языке консоли и без
 * указания, какая из десяти строк недели виновата. Поэтому форма ловит это
 * сама, до отправки, и показывает у той строки, где ошибка.
 */
import {
  type AppointmentView,
  type GridInterval,
  type ScheduleExceptionView,
  type ScheduleTemplateView,
  gridClock,
  gridMinutes,
  intervalsForDay,
  layOutDay,
} from "@quizzy/shared";

export interface Hours {
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
}

/** Что не так с промежутком: конец не позже начала или длительность приёма вне 5…480 минут */
export type HoursProblem = "order" | "slot";

export function hoursProblem(h: Hours): HoursProblem | null {
  /* «ЧЧ:ММ» сравнивается строкой — так же сравнивает сервер */
  if (!h.startsAt || !h.endsAt || h.endsAt <= h.startsAt) return "order";
  if (!Number.isInteger(h.slotMinutes) || h.slotMinutes < 5 || h.slotMinutes > 480) return "slot";
  return null;
}

/** Ошибки недели по месту строки в общем списке; пусто — неделю можно сохранять */
export function weekProblems(rows: readonly Hours[]): Map<number, HoursProblem> {
  const out = new Map<number, HoursProblem>();
  rows.forEach((row, at) => {
    const p = hoursProblem(row);
    if (p) out.set(at, p);
  });
  return out;
}

export interface ExceptionForm {
  date: string;
  kind: "off" | "extra";
  from: string;
  to: string;
  note: string;
}

export const EMPTY_EXCEPTION: ExceptionForm = { date: "", kind: "off", from: "", to: "", note: "" };

/**
 * Что мешает отправить исключение.
 *
 * «date» и «hours» — незаполненное: кнопка просто гаснет, как и раньше
 * (без даты исключения нет; дополнительные часы без часов бессмысленны).
 * «order» — заполненное неверно: об этом форма говорит словами.
 */
export function exceptionProblem(f: Pick<ExceptionForm, "date" | "kind" | "from" | "to">): "date" | "hours" | "order" | null {
  if (!f.date) return "date";
  if (f.kind === "extra" && (!f.from || !f.to)) return "hours";
  if (f.from && f.to && f.to <= f.from) return "order";
  return null;
}

/**
 * Форма после отправки: очищается только после успеха.
 *
 * Прежде поля стирались в момент нажатия, до ответа сервера. Отказал сервер
 * (пересечение с приёмом, обрыв связи) — всплывало сообщение, а дата, часы
 * и примечание уже были стёрты: исправить одну цифру и отправить ещё раз
 * было нельзя, только набрать всё заново.
 */
export function afterAdd(form: ExceptionForm, ok: boolean): ExceptionForm {
  return ok ? { ...EMPTY_EXCEPTION, kind: form.kind } : form;
}

/* ─────────── неделя календарём ─────────── */

/** Календарная дата плюс дни: «YYYY-MM-DD» без поясов — та же арифметика, что у сервера */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** ISO-номер дня недели: 1 — понедельник, 7 — воскресенье */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const day = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Понедельник недели, в которую попадает дата */
export function mondayOf(date: string): string {
  return addDays(date, 1 - weekdayOf(date));
}

export function weekDates(monday: string): string[] {
  return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(monday, i));
}

const wallFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * Стенные часы момента по поясу отделения: день и минуты от полуночи.
 *
 * Не по поясу браузера: неделю считает сервер по часам отделения (как
 * «Сьогодні»), и приём в 23:30 обязан встать в тот же день, что и там, на
 * каком бы компьютере ни открыли расписание.
 */
export function wallOf(iso: string, tz: string): { date: string; minutes: number } {
  let f = wallFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    wallFormats.set(tz, f);
  }
  const parts = f.formatToParts(new Date(iso));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "00";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/** Приём [start, end) в минутах задевает часы «HH:MM–HH:MM» */
export function gridOverlap(start: number, end: number, from: string, to: string): boolean {
  return start < gridMinutes(to) && gridMinutes(from) < end;
}

/** «09:30» из минут от полуночи */
export function clock(minutes: number): string {
  return gridClock(Math.max(0, Math.min(minutes, 24 * 60)));
}

export interface Band {
  from: number;
  to: number;
  kind: "regular" | "extra" | "off";
  note: string | null;
}

/** День глазами календаря: полосы часов, выходной, окна по сетке */
export interface DayPlan {
  date: string;
  weekday: number;
  bands: Band[];
  /** Исключение «не приймаю» на весь день (с его примечанием) */
  offAllDay: { note: string | null } | null;
  /** Окна, которые сетка даёт в этот день (та же раскладка, что у сервера) */
  windows: number;
  /** Минут приёма по сетке */
  minutes: number;
}

type TemplateRow = Pick<ScheduleTemplateView, "weekday" | "startsAt" | "endsAt" | "slotMinutes">;

/**
 * Что календарь рисует в день: обычные часы (шаблон минус «не приймаю»),
 * дополнительные часы, «не приймаю» с часами — отдельной полосой — и окна.
 *
 * Окна считает та же раскладка, что кладёт слоты на сервере
 * (@quizzy/shared/scheduleGrid): «3 з 6» в шапке дня — это ровно шесть
 * слотов, которые сетка даёт.
 */
export function planDay(date: string, templates: readonly TemplateRow[], exceptions: readonly ScheduleExceptionView[]): DayPlan {
  const weekday = weekdayOf(date);
  const tpl = templates.map((t) => ({ weekday: t.weekday, from: t.startsAt, to: t.endsAt, slotMinutes: t.slotMinutes }));
  const own = exceptions.filter((e) => e.date === date);
  const offs = own.filter((e) => e.kind === "off").map((e) => ({ from: e.startsAt, to: e.endsAt, note: e.note }));
  const extras: GridInterval[] = own
    .filter((e) => e.kind === "extra" && e.startsAt && e.endsAt)
    .map((e) => ({ from: e.startsAt!, to: e.endsAt!, slotMinutes: e.slotMinutes ?? 50 }));

  const allDay = offs.find((o) => !o.from || !o.to) ?? null;
  const laid = layOutDay(intervalsForDay(weekday, tpl, offs, extras));
  const regular = allDay ? [] : intervalsForDay(weekday, tpl, offs, []);

  const bands: Band[] = [
    ...regular.map((i): Band => ({ from: gridMinutes(i.from), to: gridMinutes(i.to), kind: "regular", note: null })),
    ...own
      .filter((e) => e.kind === "extra" && e.startsAt && e.endsAt)
      .map((e): Band => ({ from: gridMinutes(e.startsAt!), to: gridMinutes(e.endsAt!), kind: "extra", note: e.note })),
    ...(allDay
      ? []
      : offs
          .filter((o) => o.from && o.to)
          .map((o): Band => ({ from: gridMinutes(o.from!), to: gridMinutes(o.to!), kind: "off", note: o.note }))),
  ];
  return {
    date,
    weekday,
    bands,
    offAllDay: allDay ? { note: allDay.note } : null,
    windows: laid.length,
    minutes: laid.reduce((sum, s) => sum + gridMinutes(s.to) - gridMinutes(s.from), 0),
  };
}

/** Приём живой: время за ним ещё держится (не отменён, не закрыт неявкой и не проведён) */
const LIVE = new Set(["booked", "confirmed", "arrived", "in_progress"]);

/** Перенести можно только приём, который ещё не начался (RESCHEDULABLE на сервере) */
export function movable(a: Pick<AppointmentView, "status">): boolean {
  return a.status === "booked" || a.status === "confirmed";
}

/** Вид приёма в календаре: проведено, записано, идёт или следующий, неявка, поза розкладом */
export type ApptLook = "done" | "booked" | "now" | "noShow" | "off";

export function apptLook(a: Pick<AppointmentView, "status" | "offSchedule">, next: boolean): ApptLook {
  if (a.offSchedule && LIVE.has(a.status)) return "off";
  if (a.status === "no_show") return "noShow";
  if (a.status === "done") return "done";
  if (a.status === "arrived" || a.status === "in_progress" || next) return "now";
  return "booked";
}

/**
 * Следующий приём сегодня — тот, что подсвечивается заливкой: идёт или
 * начнётся ближе всех. Только сегодня и только живой: завтрашний приём
 * «следующим» в недельной картине не выглядит.
 */
export function nextToday(appts: readonly AppointmentView[], tz: string, today: string, now: number): string | null {
  let best: AppointmentView | null = null;
  for (const a of appts) {
    if (a.status !== "booked" && a.status !== "confirmed") continue;
    if (wallOf(a.startsAt, tz).date !== today) continue;
    if (Date.parse(a.endsAt) <= now) continue;
    if (!best || Date.parse(a.startsAt) < Date.parse(best.startsAt)) best = a;
  }
  return best?.id ?? null;
}

export interface Placed<T> {
  item: T;
  start: number;
  end: number;
  /** Колонка внутри пересечения и сколько их: пересекающиеся приёмы стоят рядом, а не друг на друге */
  col: number;
  cols: number;
}

/**
 * Раскладка приёмов дня по колонкам.
 *
 * У одного специалиста открытые окна не пересекаются (0105), но приёмы —
 * могут: два человека в одном окне на двоих, приём вне расписания, вокруг
 * которого легла новая сетка. Наложенные друг на друга блоки прятали бы
 * имя нижнего, поэтому пересекающиеся встают рядом, а подробности каждого —
 * в поповере.
 */
export function placeDay<T>(items: readonly { item: T; start: number; end: number }[]): Placed<T>[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Placed<T>[] = [];
  let cluster: Placed<T>[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = cluster.reduce((n, p) => Math.max(n, p.col + 1), 1);
    for (const p of cluster) p.cols = cols;
    out.push(...cluster);
    cluster = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.start >= clusterEnd) flush();
    const ends: number[] = [];
    for (const p of cluster) ends[p.col] = Math.max(ends[p.col] ?? -1, p.end);
    let col = 0;
    while (ends[col] !== undefined && ends[col]! > it.start) col++;
    cluster.push({ ...it, col, cols: 1 });
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  if (cluster.length) flush();
  return out;
}

export interface WeekStats {
  /** Часов приёма по сетке за неделю */
  hours: number;
  /** Окон по сетке */
  windows: number;
  /** Приёмов в окнах (без «поза розкладом») */
  taken: number;
  /** Свободных окон впереди: открыты, не заняты, ещё не начались */
  free: number;
  /** Живых приёмов поза розкладом — их надо перенести или оставить */
  off: number;
  /** В неделе есть ещё не прошедшее время */
  ahead: boolean;
}

export function weekStats(
  plans: readonly DayPlan[],
  appts: readonly AppointmentView[],
  slots: readonly { id: string; startsAt: string; offSchedule: boolean }[],
  to: string,
  now: number,
  tz: string,
): WeekStats {
  const busy = new Set(appts.map((a) => a.slotId));
  const today = wallOf(new Date(now).toISOString(), tz).date;
  return {
    hours: plans.reduce((s, p) => s + p.minutes, 0) / 60,
    windows: plans.reduce((s, p) => s + p.windows, 0),
    taken: appts.filter((a) => !a.offSchedule).length,
    free: slots.filter((s) => !s.offSchedule && !busy.has(s.id) && Date.parse(s.startsAt) > now).length,
    off: appts.filter((a) => a.offSchedule && LIVE.has(a.status)).length,
    ahead: today < to,
  };
}

/** Часы, которые календарь показывает: от раннего начала до позднего конца, по целым часам */
export function hourRange(plans: readonly DayPlan[], spans: readonly { start: number; end: number }[]): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const p of plans)
    for (const b of p.bands) {
      lo = Math.min(lo, b.from);
      hi = Math.max(hi, b.to);
    }
  for (const s of spans) {
    lo = Math.min(lo, s.start);
    hi = Math.max(hi, s.end);
  }
  if (!Number.isFinite(lo)) return [9, 18];
  const from = Math.max(0, Math.floor(lo / 60));
  const to = Math.min(24, Math.max(from + 1, Math.ceil(hi / 60)));
  return [from, to];
}
