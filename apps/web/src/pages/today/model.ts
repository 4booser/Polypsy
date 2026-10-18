import type { AlertCase, AppointmentView, WorkItem } from "@quizzy/shared";

/**
 * «Сьогодні» (Polypsy 2.0) без React: шкала дня, состояние сессии, перетини,
 * готовность к сессии, кто стоит в «Дія зараз». Время «сейчас» приходит
 * аргументом — проверки не зависят от часа прогона
 * (apps/web/test/todayModel.test.ts).
 */

/* ─────────── время ─────────── */

/** Минуты от местной полуночи: шкала дня — стенное время того, кто смотрит */
export function minuteOfDay(iso: string | number | Date): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

/** «09:05» — 24-часовой формат, как на табличке кабинета, при любом языке браузера */
export function hhmm(iso: string | number | Date): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** «2:48» — часы и минуты длительности */
export function hmm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** Местный календарный день «YYYY-MM-DD» */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Длительность словами-числами: часы и минуты отдельно — подписи даёт экран */
export function splitDuration(minutes: number): { h: number; m: number } {
  const total = Math.max(0, Math.round(minutes));
  return { h: Math.floor(total / 60), m: total % 60 };
}

/* ─────────── шкала дня ─────────── */

export interface Span {
  id: string;
  start: number;
  end: number;
}

export interface AxisTick {
  /** Минуты от полуночи, кратные часу */
  minute: number;
  pct: number;
}

export interface AxisGap {
  from: number;
  to: number;
  leftPct: number;
  widthPct: number;
}

export interface DayAxis {
  from: number;
  to: number;
  ticks: AxisTick[];
  gaps: AxisGap[];
  /** Положение момента на шкале, проценты ширины */
  at: (minute: number) => number;
}

/** Ширина сжатого промежутка без приёмов — в часах шкалы */
const GAP_UNITS = 0.75;

/**
 * Шкала дня: от первого часа приёмов до последнего, пустые промежутки от
 * двух часов сжаты в одну метку «без прийомів».
 *
 * Пропорциональная шкала с десятью часами, из которых приёмы занимают три,
 * — это семь часов пустого поля и блоки шириной в палец. Сжатие сохраняет
 * порядок и пропорции внутри занятого времени и честно называет пропуск.
 *
 * `now` попадает на шкалу всегда, когда передан: «зараз» нужно видеть и в
 * восемь вечера после дневного приёма, — пропуск до него просто сожмётся.
 */
export function dayAxis(spans: readonly Span[], now: number | null): DayAxis | null {
  const marks = spans.flatMap((s) => [s.start, s.end]);
  if (!marks.length) return null;
  if (now !== null) marks.push(now);
  const from = Math.floor(Math.min(...marks) / 60) * 60;
  const to = Math.max(from + 60, Math.ceil(Math.max(...marks) / 60) * 60);

  /* час занят, если в нём есть приём или «сейчас» */
  const hours = (to - from) / 60;
  const busy = Array.from({ length: hours }, (_, i) => {
    const a = from + i * 60;
    const b = a + 60;
    return spans.some((s) => s.start < b && s.end > a) || (now !== null && now >= a && now < b);
  });

  /* отрезки шкалы: [начало, конец, ширина в часах шкалы] */
  const segs: { a: number; b: number; units: number; gap: boolean }[] = [];
  for (let i = 0; i < hours; ) {
    if (!busy[i]) {
      let j = i;
      while (j < hours && !busy[j]) j++;
      const run = j - i;
      if (run >= 2) {
        segs.push({ a: from + i * 60, b: from + j * 60, units: GAP_UNITS, gap: true });
        i = j;
        continue;
      }
    }
    segs.push({ a: from + i * 60, b: from + (i + 1) * 60, units: 1, gap: false });
    i++;
  }
  const total = segs.reduce((n, s) => n + s.units, 0);

  const at = (minute: number): number => {
    let acc = 0;
    for (const s of segs) {
      if (minute <= s.b) {
        const k = Math.max(0, Math.min(1, (minute - s.a) / (s.b - s.a)));
        return ((acc + k * s.units) / total) * 100;
      }
      acc += s.units;
    }
    return 100;
  };

  const ticks: AxisTick[] = [];
  const seen = new Set<number>();
  for (const s of segs) {
    for (const m of [s.a, s.b]) {
      if (seen.has(m)) continue;
      seen.add(m);
      ticks.push({ minute: m, pct: at(m) });
    }
  }
  const gaps = segs
    .filter((s) => s.gap)
    .map((s) => ({ from: s.a, to: s.b, leftPct: at(s.a), widthPct: at(s.b) - at(s.a) }));
  return { from, to, ticks, gaps, at };
}

/**
 * Ряд блока на шкале: перекрывающиеся приёмы встают в две половины по
 * высоте, а не друг на друга. Ранний — сверху.
 */
export function lanes(spans: readonly Span[]): Map<string, "full" | "top" | "bot"> {
  const out = new Map<string, "full" | "top" | "bot">();
  const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const s of sorted) {
    const clash = sorted.find((o) => o.id !== s.id && o.start < s.end && o.end > s.start);
    if (!clash) out.set(s.id, "full");
    else out.set(s.id, clash.start < s.start || (clash.start === s.start && clash.id < s.id) ? "bot" : "top");
  }
  return out;
}

/* ─────────── сессия ─────────── */

export type Status = AppointmentView["status"];

/** Приём, который ещё идёт по ходу дня: не отменён и не отмечен неявкой */
export const live = (a: Pick<AppointmentView, "status">) => a.status !== "cancelled" && a.status !== "no_show";

export type SessionState = "done" | "noshow" | "here" | "next" | "later" | "late";

/**
 * Где сессия сейчас относительно дня.
 *
 *   here  — человек пришёл или приём идёт;
 *   next  — первая из ждущих, к ней и готовятся;
 *   late  — время прошло, а отметки нет (фоновый проход поставит неявку
 *           через два часа — до того специалист видит, что забыл нажать);
 *   later — остальные ждущие.
 *
 * `now` — null для другого дня: тогда «следующей» считается первая ждущая
 * дня, а опозданий нет.
 */
export function sessionStates(items: readonly AppointmentView[], now: number | null): Map<string, SessionState> {
  const out = new Map<string, SessionState>();
  let nextTaken = false;
  const sorted = [...items].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  for (const a of sorted) {
    if (a.status === "done") out.set(a.id, "done");
    else if (a.status === "no_show" || a.status === "cancelled") out.set(a.id, "noshow");
    else if (a.status === "arrived" || a.status === "in_progress") out.set(a.id, "here");
    else if (now !== null && Date.parse(a.endsAt) <= now) out.set(a.id, "late");
    else if (!nextTaken) {
      out.set(a.id, "next");
      nextTaken = true;
    } else out.set(a.id, "later");
  }
  return out;
}

/**
 * Сессия, к которой готовятся: идущая, иначе следующая. Нет ни той ни
 * другой — день окончен, панель подготовки говорит об этом сама.
 */
export function focusSession(items: readonly AppointmentView[], now: number | null): AppointmentView | null {
  const states = sessionStates(items, now);
  return items.find((a) => states.get(a.id) === "here") ?? items.find((a) => states.get(a.id) === "next") ?? null;
}

/** Где в списке встаёт строка «Зараз»: перед первой сессией, что начнётся позже */
export function nowIndex(items: readonly AppointmentView[], now: number): number {
  const i = items.findIndex((a) => Date.parse(a.startsAt) > now);
  return i === -1 ? items.length : i;
}

export interface Clash {
  withId: string;
  withName: string;
  from: string;
  to: string;
}

/**
 * Перетини: два живых приёма одного специалиста в одно время. Сервер
 * запрещает пересекающиеся слоты, но «поза розкладом» и записи разных
 * путей их всё же дают — и узнавать об этом в момент, когда второй человек
 * уже стучит в дверь, поздно.
 */
export function clashes(items: readonly AppointmentView[]): Map<string, Clash> {
  const out = new Map<string, Clash>();
  const alive = items.filter(live);
  for (const a of alive) {
    for (const b of alive) {
      if (a.id === b.id) continue;
      const s = Math.max(Date.parse(a.startsAt), Date.parse(b.startsAt));
      const e = Math.min(Date.parse(a.endsAt), Date.parse(b.endsAt));
      if (s < e && !out.has(a.id)) {
        out.set(a.id, { withId: b.id, withName: b.patientName, from: new Date(s).toISOString(), to: new Date(e).toISOString() });
      }
    }
  }
  return out;
}

/* ─────────── готовность ─────────── */

export type CellTone = "ok" | "new" | "miss" | "none" | "risk";

export interface ReadyCell {
  key: "measures" | "booking" | "reason";
  tone: CellTone;
  /** Ключ словаря и подстановки: подписи принадлежат экрану */
  text: { key: string; n?: number; at?: string };
}

/**
 * Готовность к сессии тремя клетками — то, что есть у приёма на деле.
 *
 *   Заміри  — несданное назначенное и скрининг при записи;
 *   Запис   — подтвердил ли человек время и не выпал ли слот из розкладу;
 *   Привід  — причина звернення словами пацієнта.
 */
export function readiness(a: AppointmentView): ReadyCell[] {
  const measures: ReadyCell =
    a.pendingAssignments > 0
      ? { key: "measures", tone: "miss", text: { key: "day.pending", n: a.pendingAssignments } }
      : a.screeningDone === false
        ? { key: "measures", tone: "miss", text: { key: "dayA.rdyScreenMissing" } }
        : a.screeningDone === true
          ? { key: "measures", tone: "ok", text: { key: "dayA.rdyScreenDone" } }
          : { key: "measures", tone: "none", text: { key: "dayA.rdyNoAssigned" } };
  const booking: ReadyCell = a.offSchedule
    ? { key: "booking", tone: "miss", text: { key: "dayA.rdyOffSchedule" } }
    : a.status === "booked"
      ? { key: "booking", tone: "miss", text: { key: "dayA.rdyUnconfirmed" } }
      : a.confirmedAt
        ? { key: "booking", tone: "ok", text: { key: "dayA.rdyConfirmed", at: a.confirmedAt } }
        : { key: "booking", tone: "none", text: { key: "dayA.rdyBooked", at: a.bookedAt } };
  const reason: ReadyCell = a.reason
    ? { key: "reason", tone: "new", text: { key: "dayA.rdyReason" } }
    : { key: "reason", tone: "none", text: { key: "dayA.rdyNoReason" } };
  return [measures, booking, reason];
}

/* ─────────── «Дія зараз» ─────────── */

export interface Timer {
  elapsed: string;
  /** Норма, минут */
  norm: number;
  pct: number;
  /** Сколько осталось до нормы; отрицательное — просрочено на столько */
  left: number;
  /** Момент, до которого разобрать */
  due: string;
}

/** Таймер случая по норме методики; без нормы — null, и таймера нет вовсе */
export function caseTimer(c: Pick<AlertCase, "minutesOpen" | "escalateMinutes" | "openedAt">): Timer | null {
  const norm = c.escalateMinutes ?? null;
  if (!norm || norm <= 0) return null;
  return {
    elapsed: hmm(c.minutesOpen),
    norm,
    pct: Math.min(100, (c.minutesOpen / norm) * 100),
    left: norm - c.minutesOpen,
    due: new Date(Date.parse(c.openedAt) + norm * 60_000).toISOString(),
  };
}

const SEV_RANK: Record<string, number> = { severe: 0, moderate: 1 };

/**
 * Порядок срочности открытых случаев: тяжёлые раньше, затем меньше
 * осталось до нормы, затем дольше ждут. Свои и ничьи — раньше чужих: чужой
 * случай уже разбирает коллега, и первым номером он здесь только мешал бы.
 */
export function urgentCases(cases: readonly AlertCase[], meId: string | null): AlertCase[] {
  const left = (c: AlertCase) => (c.escalateMinutes ? c.escalateMinutes - c.minutesOpen : Number.POSITIVE_INFINITY);
  const foreign = (c: AlertCase) => (c.assignedTo && c.assignedTo !== meId ? 1 : 0);
  return cases
    .filter((c) => !c.acknowledgedAt)
    .sort(
      (a, b) =>
        foreign(a) - foreign(b) ||
        (SEV_RANK[a.severity] ?? 2) - (SEV_RANK[b.severity] ?? 2) ||
        left(a) - left(b) ||
        b.minutesOpen - a.minutesOpen,
    );
}

/**
 * Пункты очереди, которые идут в «Дія зараз» рядом со случаями: только
 * просроченное. Остальное — «Між сесіями».
 */
export function overdueWork(items: readonly WorkItem[]): WorkItem[] {
  return items.filter((i) => i.overdue && i.kind !== "message");
}

/**
 * «Між сесіями»: что можно сделать за пять минут между людьми — письма,
 * неявки, результаты. Человек героя «Дія зараз» сюда не идёт: его пункты уже
 * стоят строкой открытого.
 */
export function betweenSessions(items: readonly WorkItem[], skipUser: string | null, shown: ReadonlySet<string>, limit = 6): WorkItem[] {
  return items.filter((i) => i.userId !== skipUser && !shown.has(`${i.kind}-${i.id}`)).slice(0, limit);
}
