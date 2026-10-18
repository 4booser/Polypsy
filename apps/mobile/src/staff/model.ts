/**
 * Экраны сотрудника на телефоне — решения без react-native.
 *
 * Здесь то, что легко сломать незаметно: в каком порядке обход ведёт по
 * палатам, сколько осталось до нормы разбора, какое слово стоит у сдвига
 * балла, где проходят полосы на графике курса. Экраны только рисуют то, что
 * вернули эти функции, а тест (test/staffModel.test.ts) проверяет их без
 * отрисовки.
 */
import {
  measurementError,
  polarityOfBands,
  type DynamicsPoint,
  type RespondentDynamics,
  type ScaleBand,
  type ScaleDynamics,
  type Severity,
  type SurveyFull,
  type WorkItem,
  type WorkKind,
} from "@quizzy/shared";

const MINUTE = 60_000;
const DAY = 86_400_000;

/* ─────────── время ─────────── */

const two = (n: number) => String(n).padStart(2, "0");

/** Календарный день устройства «2026-10-08»: телефон отделения живёт в его поясе */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** «08.10» */
export function dm(iso: string): string {
  const d = new Date(iso);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}`;
}

/** «14:12» */
export function hm(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Минуты часами: 168 → «2:48» */
export function clock(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${two(m % 60)}`;
}

/** Норма часами без лишних нулей: 240 → «4», 90 → «1,5» */
export function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 10) / 10;
  return String(h).replace(".", ",");
}

/**
 * Часы разбора случая: сколько прошло от открытия, сколько до нормы и
 * когда она истекает.
 *
 * Норма — настройка эскалации методики (alertEscalateMinutes); её нет —
 * часы идут без нормы, и тогда ни «до 18:12», ни полоски не рисуется:
 * срок, которого никто не назначал, выглядел бы обязательством.
 */
export interface CaseClock {
  elapsed: number;
  norm: number | null;
  /** Доля нормы, 0–100; без нормы 0 */
  pct: number;
  due: Date | null;
  /** Минут до нормы; отрицательное — просрочено на столько */
  left: number | null;
  over: boolean;
}

export function caseClock(openedAt: string, norm: number | null, now: number): CaseClock {
  const opened = Date.parse(openedAt);
  const elapsed = Math.max(0, Math.floor((now - opened) / MINUTE));
  if (!norm || norm <= 0) return { elapsed, norm: null, pct: 0, due: null, left: null, over: false };
  const left = norm - elapsed;
  return {
    elapsed,
    norm,
    pct: Math.min(100, Math.round((elapsed / norm) * 100)),
    due: new Date(opened + norm * MINUTE),
    left,
    over: left < 0,
  };
}

/* ─────────── обход ─────────── */

export interface RoundsPerson {
  userId: string;
  userName: string;
  unit: string | null;
  items: WorkItem[];
  overdue: boolean;
  /** Сколько дней ждёт самое давнее */
  days: number;
  visited: boolean;
}

export interface RoundsWard {
  unit: string | null;
  people: RoundsPerson[];
}

/**
 * Обход по палатам: подразделение → человек → что от специалиста ждут.
 *
 * Единица обхода — человек, а не вид работы: к койке подходят один раз,
 * а не по разу на каждое просроченное назначение. Внутри палаты сначала
 * просроченное и самое давнее; отмеченные «відвідано» остаются на месте —
 * обход идут по коридору, и строка, прыгнувшая в конец, сбивает с пути.
 * Палаты — по числу людей, «без подразделения» последней.
 */
export function roundsWards(items: readonly WorkItem[], visited: ReadonlySet<string>): RoundsWard[] {
  const wards = new Map<string, RoundsWard>();
  const people = new Map<string, RoundsPerson>();
  for (const item of items) {
    const unitKey = item.unit ?? "";
    let ward = wards.get(unitKey);
    if (!ward) {
      ward = { unit: item.unit, people: [] };
      wards.set(unitKey, ward);
    }
    const key = `${unitKey}\u0000${item.userId}`;
    let person = people.get(key);
    if (!person) {
      person = { userId: item.userId, userName: item.userName, unit: item.unit, items: [], overdue: false, days: 0, visited: visited.has(item.userId) };
      people.set(key, person);
      ward.people.push(person);
    }
    person.items.push(item);
    person.overdue ||= item.overdue;
    person.days = Math.max(person.days, item.days ?? 0);
  }
  for (const ward of wards.values()) {
    for (const p of ward.people) p.items.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (b.days ?? 0) - (a.days ?? 0));
    ward.people.sort((a, b) => Number(b.overdue) - Number(a.overdue) || b.days - a.days);
  }
  return [...wards.values()].sort((a, b) => {
    if ((a.unit === null) !== (b.unit === null)) return a.unit === null ? 1 : -1;
    return b.people.length - a.people.length;
  });
}

export type RoundsFilter = "all" | "overdue" | "visited" | WorkKind;

export const WORK_KINDS: readonly WorkKind[] = ["noshow", "message", "followup", "assignment", "dispensary", "referral"];

export function roundsMatch(p: RoundsPerson, f: RoundsFilter): boolean {
  if (f === "all") return true;
  if (f === "overdue") return p.overdue;
  if (f === "visited") return p.visited;
  return p.items.some((i) => i.kind === f);
}

/** Сколько людей за каждым фильтром — ровно столько строк покажет нажатие */
export function roundsCounts(wards: readonly RoundsWard[]): Record<RoundsFilter, number> {
  const all = wards.flatMap((w) => w.people);
  const out = { all: all.length, overdue: 0, visited: 0 } as Record<RoundsFilter, number>;
  for (const k of WORK_KINDS) out[k] = 0;
  for (const p of all) {
    if (p.overdue) out.overdue += 1;
    if (p.visited) out.visited += 1;
    for (const k of new Set(p.items.map((i) => i.kind))) out[k] += 1;
  }
  return out;
}

/* ─────────── отметки обхода ─────────── */

export interface VisitedMarks {
  day: string;
  ids: string[];
}

/** Отметки сегодняшнего обхода; вчерашние не переносятся — обход каждый день новый */
export function visitedOn(stored: VisitedMarks | null | undefined, today: string): Set<string> {
  return new Set(stored && stored.day === today ? stored.ids : []);
}

export function toggleVisited(stored: VisitedMarks | null | undefined, today: string, userId: string): VisitedMarks {
  const ids = visitedOn(stored, today);
  if (ids.has(userId)) ids.delete(userId);
  else ids.add(userId);
  return { day: today, ids: [...ids] };
}

/* ─────────── шкалы и сдвиг ─────────── */

export type Better = "up" | "down";
export type Verdict = "better" | "worse" | "changed" | "within" | "unknown";

/**
 * Слово для сдвига от старта — то же правило, что у графика курса консоли
 * (apps/web/src/charts/courseModel.ts): надёжен сдвиг больше порога,
 * ровно на пороге — ещё «у межах похибки»; без порога — неизвестно; без
 * полярности — «змінилось», но не «краще».
 */
export function changeVerdict(delta: number, rc: number | null, better: Better | null): Verdict {
  if (rc === null || !Number.isFinite(rc) || rc <= 0) return "unknown";
  if (Math.abs(delta) <= rc) return "within";
  if (better === null) return "changed";
  const improved = better === "down" ? delta < 0 : delta > 0;
  return improved ? "better" : "worse";
}

/** Порог надёжной зміни в баллах шкалы: из основы RCI, иначе из SEM; нечем — null */
export function reliableThreshold(scale: Pick<ScaleDynamics, "sem" | "reliableChange">): number | null {
  const basis = scale.reliableChange?.basis;
  if (basis) {
    const me = measurementError(basis.sd, basis.alpha);
    if (me) return me.mdc95;
  }
  if (scale.sem != null && scale.sem > 0) return Math.round(1.96 * Math.SQRT2 * scale.sem * 100) / 100;
  return null;
}

/** «Краще ↓ / ↑» по полосам самой шкалы; немонотонные полосы — неизвестно */
export function betterOf(bands: readonly Pick<ScaleBand, "minScore" | "maxScore" | "severity">[] | null): Better | null {
  if (!bands?.length) return null;
  const higherIsWorse = polarityOfBands(bands.map((b) => ({ minScore: b.minScore, maxScore: b.maxScore, severity: b.severity })));
  return higherIsWorse === null ? null : higherIsWorse ? "down" : "up";
}

/** Полосы шкалы из описания методики: по id шкалы, иначе по коду (у версий id разные) */
export function bandsOf(survey: Pick<SurveyFull, "scales"> | null | undefined, scale: Pick<ScaleDynamics, "scaleId" | "code">): ScaleBand[] | null {
  const s = survey?.scales?.find((x) => x.id === scale.scaleId) ?? survey?.scales?.find((x) => x.code === scale.code);
  return s?.bands?.length ? [...s.bands].sort((a, b) => a.minScore - b.minScore) : null;
}

const sorted = (points: readonly DynamicsPoint[]) => [...points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));

/** Число так, как его печатают: целое без дробной части, иначе одна-две цифры после запятой */
export function num(v: number): string {
  const r = Math.round(v * 100) / 100;
  return String(r).replace(".", ",");
}

export interface InstrumentRow {
  key: string;
  surveyId: string;
  surveyTitle: string;
  scaleId: string;
  code: string;
  title: string;
  last: DynamicsPoint;
  /** Последние значения по порядку — «19 → 16 → 14» */
  history: number[];
  /** От первого замера; null — сравнивать не с чем или нельзя */
  delta: number | null;
  rc: number | null;
  better: Better | null;
  verdict: Verdict;
  count: number;
}

/**
 * Строки «последний балл по каждой шкале» — карта у койки и обзор карты.
 *
 * Сдвиг считается от первого замера, но только если сервер не назвал их
 * несравнимыми (разные версии, единицы, недостоверный протокол): иначе
 * «−5» выглядело бы динамикой, которой нет.
 */
export function instrumentRows(
  d: Pick<RespondentDynamics, "surveys">,
  surveyOf: (surveyId: string) => Pick<SurveyFull, "scales"> | null | undefined,
  keep = 4,
): InstrumentRow[] {
  const rows: InstrumentRow[] = [];
  for (const sv of d.surveys) {
    for (const sc of sv.scales) {
      const pts = sorted(sc.points);
      const last = pts.at(-1);
      if (!last) continue;
      const rc = reliableThreshold(sc);
      const better = betterOf(bandsOf(surveyOf(sv.surveyId), sc));
      // сервер считает сдвиг сам (с приведением версий) и отдаёт null, когда сравнивать нельзя
      const delta = pts.length > 1 && !sc.incomparable ? sc.delta : null;
      rows.push({
        key: `${sv.surveyId}:${sc.scaleId}`,
        surveyId: sv.surveyId,
        surveyTitle: sv.title,
        scaleId: sc.scaleId,
        code: sc.code,
        title: sc.title,
        last,
        history: pts.slice(-keep).map((p) => p.rawScore),
        delta,
        rc,
        better,
        verdict: delta === null ? "unknown" : changeVerdict(delta, rc, better),
        count: pts.length,
      });
    }
  }
  return rows;
}

/** Ступень набора 0…4 по выраженности: цвет точки на графике курса */
export const STEP_OF: Record<Severity, 0 | 1 | 2 | 3 | 4> = { none: 0, mild: 1, moderate: 2, severe: 4 };

export interface CourseInput {
  points: { t: number; label: string; value: number; severity: Severity | null; bandLabel: string | null }[];
  bands: { from: number; to: number; label: string }[];
  min: number;
  max: number;
  rc: number | null;
  better: Better | null;
}

/**
 * Динамика шкалы → вход графика курса (viz/CourseChart).
 *
 * Полосы — лестница методики «від — до» как непрерывные отрезки: верх
 * полосы — начало следующей, у последней — её максимум; так 4,5 не падает
 * в щель между 0–4 и 5–9. Верх оси — максимум шкалы из полос или из самой
 * точки (стены — 10), а если нет ни того ни другого — наибольшее значение.
 * Порог из старта, снятого недостоверным протоколом, не рисуется.
 */
export function courseInput(scale: ScaleDynamics, bands: readonly ScaleBand[] | null, top: number | null): CourseInput {
  const pts = sorted(scale.points);
  const ladder = bands ? [...bands].sort((a, b) => a.minScore - b.minScore) : [];
  const courseBands = ladder.map((b, i) => ({ from: b.minScore, to: ladder[i + 1]?.minScore ?? b.maxScore, label: b.label }));
  const values = pts.map((p) => p.rawScore);
  const min = Math.min(0, ...values, ...(ladder.length ? [ladder[0]!.minScore] : []));
  const max = Math.max(...values, ladder.at(-1)?.maxScore ?? -Infinity, top ?? -Infinity);
  return {
    points: pts.map((p) => ({
      t: Date.parse(p.submittedAt),
      label: dm(p.submittedAt),
      value: p.rawScore,
      severity: p.severity,
      bandLabel: p.bandLabel,
    })),
    bands: courseBands,
    min,
    max: max > min ? max : min + 1,
    rc: pts[0]?.reliable === false ? null : reliableThreshold(scale),
    better: betterOf(ladder),
  };
}

/* ─────────── списки по дням ─────────── */

export interface DayGroup<T> {
  day: string;
  /** 0 — сегодня, 1 — вчера, дальше — давность в днях */
  ago: number;
  rows: T[];
}

/** Строки по календарным дням, новые сверху; без даты — в конце отдельной группой */
export function byDay<T>(rows: readonly T[], at: (row: T) => string | null, now: Date): DayGroup<T>[] {
  const today = Date.parse(`${dayKey(now)}T00:00:00`);
  const groups = new Map<string, DayGroup<T>>();
  for (const row of rows) {
    const iso = at(row);
    const day = iso ? dayKey(new Date(iso)) : "";
    let g = groups.get(day);
    if (!g) {
      const ago = day ? Math.round((today - Date.parse(`${day}T00:00:00`)) / DAY) : Number.POSITIVE_INFINITY;
      g = { day, ago, rows: [] };
      groups.set(day, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()].sort((a, b) => a.ago - b.ago);
}

/**
 * Последние n календарных дней по дням с нулями: в ленте сервера есть
 * только дни со сдачами, и столбики без пустых дней сжали бы выходные в
 * ничто — а спад на выходных и есть то, что на них видно.
 */
export function lastDays(timeline: readonly { date: string; count: number }[], n: number, now: Date): { key: string; value: number; date: Date }[] {
  const by = new Map(timeline.map((t) => [t.date, t.count]));
  const out: { key: string; value: number; date: Date }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(d);
    out.push({ key, value: by.get(key) ?? 0, date: d });
  }
  return out;
}

/** Инициалы для кружка: «Мельник Андрій Олегович» → «МА» (фамилия первой, как в списках) */
export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/** «Мельник Андрій Олегович» → «Мельник А. О.» */
export function shortName(name: string | null | undefined): string {
  const [last, ...rest] = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (!last) return "";
  return [last, ...rest.slice(0, 2).map((p) => `${p[0]!.toUpperCase()}.`)].join(" ");
}
