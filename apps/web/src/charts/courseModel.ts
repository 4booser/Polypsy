import {
  comparability,
  measurementError,
  pointValueTop,
  polarityOfBands,
  type ComparableMark,
  type DynamicsPoint,
  type Incomparable,
  type ResponseSource,
  type ScaleDynamics,
  type Severity,
} from "@quizzy/shared";
import { day } from "../format";
import { boundaries, ladderDomain, rungOf, sortRungs, type Rung } from "./ladder";
import { axisFor } from "./scale";

/**
 * Модель графика курса (CourseChart): чистые функции без React.
 *
 * Здесь решается всё, что можно проверить без отрисовки: куда ляжет точка,
 * какое слово стоит у сдвига, где клинический порог, как встанут подписи
 * полос, какие события попадают на дорожку и к какому замеру привязан
 * сигнал. Компонент (course.tsx) только рисует то, что вернули эти функции,
 * — и тест (apps/web/test/courseChart.test.tsx) проверяет и то и другое.
 *
 * Откуда числа — только из приложения:
 *
 *   — замеры: динамика пациента (GET /api/dynamics/respondents/:id), по
 *     точке на завершённое прохождение, с тем, кто заполнял (source);
 *   — полосы: лестница шкалы методики (bands), та же, что у линейки;
 *   — «менше — краще / більше — краще»: полярность по самим полосам
 *     (polarityOfBands) — флага в справочнике нет, и он разошёлся бы с
 *     полосами;
 *   — клинический порог: граница, с которой полосы методики помірні або
 *     виражені (cutoffOf) — то же «у клінічних смугах», что на зведенні;
 *   — порог значущої зміни: MDC95 = 1,96·√2·SEM (measurementError в
 *     shared/rci.ts) — тот же порог, что |RCI| > 1,96, только в баллах шкалы;
 *     на графике он не рисуется, а говорится словом в шапке и в подсказке;
 *   — события: хронология пациента (GET /api/timeline/:id) — приёмы со
 *     статусом, заключения и сигналы риска (сигнал — с прохождением, которое
 *     его подняло).
 *
 * Прогноза нет: приложение тренд не считает, и рисовать «тренд ≈ 11» из
 * трёх точек без модели значило бы выдать догадку за оценку.
 */

export const DAY_MS = 86_400_000;

export interface CoursePoint {
  key: string;
  /** Момент замера, мс */
  t: number;
  /** Подпись даты так, как её печатает экран */
  label: string;
  value: number;
  /** Полоса этого замера; без неё — по лестнице */
  band?: { label: string; severity: Severity } | null;
  /**
   * Почему этот замер нельзя сравнивать со стартом (разные версии, единицы,
   * недостоверный протокол); null — сравним.
   */
  incomparable?: Incomparable | null;
  /** Адрес протокола прохождения; null — открыть нечего (пример на лендинге) */
  href?: string | null;
  /** Кто и как заполнял (responses.source); null — сервер не знает */
  source?: ResponseSource | null;
}

/**
 * Событие курса. Приём, неявка, запланированный приём и заключение стоят на
 * дорожке под полем; сигнал риска — на самом замере, который его поднял
 * (`responseId`), а не на оси: сигнал говорит о замере, а не о дне.
 */
export type CourseEventKind = "session" | "noshow" | "planned" | "conclusion" | "signal";

export interface CourseEvent {
  key: string;
  t: number;
  kind: CourseEventKind;
  /** Подпись даты */
  label: string;
  /** Что за событие словами: подпись сигнала, специалист приёма, первая строка заключения */
  detail?: string | null;
  /** Прохождение, к которому событие относится: сигнал рисуется на его замере */
  responseId?: string | null;
  /** Шкала сигнала по полосе — он встаёт только на её график; null — сигнал по ответу, на все шкалы замера */
  scaleCode?: string | null;
  /** Заключение подписано; ложь — черновик */
  signed?: boolean;
}

export type Better = "down" | "up";

/* ─────────── сдвиг и его слово ─────────── */

export type ChangeVerdict = "better" | "worse" | "changed" | "within" | "unknown";

/**
 * Слово для сдвига от старта.
 *
 * Правило Jacobson–Truax в баллах: сдвиг значущий, когда по модулю больше
 * порога (|RCI| > 1,96 ⇔ |Δ| > MDC95), ровно на пороге — ещё «у межах
 * похибки», как и в classifyChange. Без порога — «unknown»: похибку не из
 * чего оценить, и слово «у межах» было бы неправдой. Без полярности —
 * «changed»: сдвиг значущий, но назвать его покращенням нельзя.
 */
export function changeVerdict(delta: number, rc: number | null, better: Better | null): ChangeVerdict {
  if (rc === null || !Number.isFinite(rc) || rc <= 0) return "unknown";
  if (Math.abs(delta) <= rc) return "within";
  if (better === null) return "changed";
  const improved = better === "down" ? delta < 0 : delta > 0;
  return improved ? "better" : "worse";
}

/** «Менше — краще / більше — краще» по лестнице: тяжесть растёт с баллом — лучше вниз; немонотонная — неизвестно */
export function betterOf(rungs: readonly Rung[]): Better | null {
  const higherIsWorse = polarityOfBands(rungs.map((r) => ({ minScore: r.min, maxScore: r.max, severity: r.severity })));
  return higherIsWorse === null ? null : higherIsWorse ? "down" : "up";
}

/**
 * Порог значущої зміни в баллах шкалы.
 *
 * Из основы RCI (SD и α выборки), если сервер её отдал, — тем же расчётом,
 * что и всюду (measurementError); иначе из SEM: MDC95 = 1,96·√2·SEM. Нет ни
 * того ни другого — null, и слово сдвига — «значущість не оцінено»:
 * придуманный порог выглядит как знание.
 */
export function reliableThreshold(scale: Pick<ScaleDynamics, "sem" | "reliableChange">): number | null {
  const basis = scale.reliableChange?.basis;
  if (basis) {
    const me = measurementError(basis.sd, basis.alpha);
    if (me) return me.mdc95;
  }
  if (scale.sem != null && scale.sem > 0) return Math.round(1.96 * Math.SQRT2 * scale.sem * 100) / 100;
  return null;
}

/* ─────────── клинический порог ─────────── */

const CLINICAL: ReadonlySet<Severity> = new Set(["moderate", "severe"]);

export interface Cutoff {
  /** Где линия на оси: граница между полосами (посередине разрыва) */
  at: number;
  /** Первый балл клинической стороны: «≥ 10» у PHQ-9, «≤ 12» у WHO-5 */
  value: number;
  /** С какой стороны клинические полосы: above — с балла и выше, below — с балла и ниже */
  side: "above" | "below";
}

/**
 * Клинический порог шкалы — одна граница, с которой полосы методики
 * помірні або виражені.
 *
 * Тем же правилом считает зведення («у клінічних смугах» — помірна і
 * виражена), и порог на графике с ним не расходится. У PHQ-9 и GAD-7 это
 * 10, у PCL-5 — 33, у WHO-5 — 12 и ниже: ровно пороги ймовірного розладу и
 * поганого благополуччя из документации методик. Клинические полосы должны
 * стоять одним куском у одного края лестницы: лестница, где «помірна»
 * посередине, а по краям — норма, одной границы не имеет, и линии нет.
 * Полос без клинических (только норма и легка) — тоже нет: порог не придумывается.
 */
export function cutoffOf(rungs: readonly Rung[]): Cutoff | null {
  const sorted = sortRungs(rungs);
  if (sorted.length < 2) return null;
  const clin = sorted.map((r) => CLINICAL.has(r.severity));
  const first = clin.indexOf(true);
  const last = clin.lastIndexOf(true);
  if (first < 0 || (first === 0 && last === sorted.length - 1)) return null;
  for (let i = first; i <= last; i++) if (!clin[i]) return null;
  const cuts = boundaries(sorted);
  if (last === sorted.length - 1) return { at: cuts[first - 1]!, value: sorted[first]!.min, side: "above" };
  if (first === 0) return { at: cuts[last]!, value: sorted[last]!.max, side: "below" };
  return null;
}

/* ─────────── данные приложения → график ─────────── */

const markOf = (p: DynamicsPoint): ComparableMark => ({
  version: p.versionNo ?? null,
  normalized: p.normalized,
  normalization: p.normalization ?? null,
  reliable: p.reliable,
});

export interface CourseData {
  points: CoursePoint[];
  rungs: Rung[];
  rc: number | null;
  better: Better | null;
  /** Нормировка последнего замера: единицы у оси и в шапке */
  normalization: DynamicsPoint["normalization"] | null;
  /** Верх шкалы в единицах значения: «19 з 27» у сырого балла и край оси; у T-балла — null */
  max: number | null;
  /** Код шкалы: сигнал по полосе другой шкалы того же прохождения на этот график не встаёт */
  scaleCode: string | null;
}

/**
 * Динамика одной шкалы → данные графика курса.
 *
 * `rungs` — лестница шкалы методики (bands из описания методики или из
 * аналитики: у динамики её нет). Порог из старта, сделанного недостоверным
 * протоколом, не считается: межа похибки от числа, которому нельзя верить, —
 * та же выдумка. `surveyId` — у точки появляется адрес протокола: без
 * методики адреса прохождения нет (App.tsx, /surveys/:id/responses/:rid).
 */
export function courseFromDynamics(
  scale: Pick<ScaleDynamics, "points" | "sem" | "reliableChange"> & { code?: string | null },
  rungs: readonly Rung[],
  formatDay: (iso: string) => string = day,
  { surveyId }: { surveyId?: string | null } = {},
): CourseData {
  const sorted = [...scale.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const ladder = sortRungs(rungs);
  const first = sorted[0];
  const points = sorted.map((p, i): CoursePoint => {
    const hit = rungOf(ladder, p.rawScore);
    return {
      key: p.responseId,
      t: Date.parse(p.submittedAt),
      label: formatDay(p.submittedAt),
      value: p.rawScore,
      band: p.severity && p.bandLabel ? { label: p.bandLabel, severity: p.severity } : hit ? { label: hit.label, severity: hit.severity } : null,
      incomparable: i && first ? comparability(markOf(first), markOf(p)) : null,
      href: surveyId ? `/surveys/${surveyId}/responses/${p.responseId}` : null,
      source: p.source ?? null,
    };
  });
  const last = sorted.at(-1);
  return {
    points,
    rungs: ladder,
    rc: first && first.reliable === false ? null : reliableThreshold(scale),
    better: betterOf(ladder),
    /* ненормированная точка нормированной шкалы (норм для пола нет) — в сырых баллах, как и её значение */
    normalization: last ? (last.normalized === false ? "raw" : (last.normalization ?? null)) : null,
    /* верх шкалы в единицах значения (#199): сырой балл — максимум, доля — 1, стен — 10, у T-балла верха нет */
    max: last ? pointValueTop(last) : null,
    scaleCode: scale.code ?? null,
  };
}

/** Строка хронологии пациента — то, что отдаёт GET /api/timeline/:userId */
export interface TimelineLike {
  id: string;
  kind: string;
  at: string;
  title: string;
  detail?: string | null;
  /** Прохождение, которое подняло сигнал или по которому написано заключение */
  responseId?: string | null;
  /** Шкала, полоса которой подняла сигнал */
  scaleCode?: string | null;
}

/**
 * Хронология → события курса.
 *
 * Приём со статусом «done», «arrived», «in_progress» — проведённый;
 * «no_show» — неявка; «booked» и «confirmed» — запланированный (в прошлом —
 * без отметки: его не считают ни проведённым, ни сорванным). Заключение —
 * подписанное или черновик. Сигнал — строка тревоги со своим прохождением.
 * Отменённые приёмы сервер в хронологию не отдаёт.
 */
export function courseEventsFromTimeline(items: readonly TimelineLike[], formatDay: (iso: string) => string = day): CourseEvent[] {
  const out: CourseEvent[] = [];
  for (const it of items) {
    const t = Date.parse(it.at);
    if (!Number.isFinite(t)) continue;
    const base = { key: it.id, t, label: formatDay(it.at), responseId: it.responseId ?? null };
    if (it.kind === "alert") out.push({ ...base, kind: "signal", detail: it.title || null, scaleCode: it.scaleCode ?? null });
    else if (it.kind === "conclusion") out.push({ ...base, kind: "conclusion", detail: it.title || null, signed: it.detail === "signed" });
    else if (it.kind === "visit") {
      const s = it.detail ?? "";
      if (s === "done" || s === "arrived" || s === "in_progress") out.push({ ...base, kind: "session", detail: it.title || null });
      else if (s === "no_show") out.push({ ...base, kind: "noshow", detail: it.title || null });
      else if (s === "booked" || s === "confirmed") out.push({ ...base, kind: "planned", detail: it.title || null });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ─────────── геометрия ─────────── */

export interface CourseLayout {
  /** Область по времени, мс */
  t0: number;
  t1: number;
  /** Область по значению */
  lo: number;
  hi: number;
  ticks: number[];
  /**
   * Край лестницы срезан: у Т-баллов Міні-мульта крайние полосы — 59 и 120
   * баллов шириной, и поле во всю лестницу сжало бы средние полосы в нитку.
   * Срезанный край обязан быть виден на графике (излом у оси).
   */
  cut: { lo: boolean; hi: boolean };
  /** События дорожки: приёмы, неявки, запланированные, заключения — около курса */
  lane: CourseEvent[];
  /** Сигналы риска по номеру замера, который их поднял */
  signals: Map<number, CourseEvent[]>;
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/**
 * Область по значению для лестницы полос.
 *
 * Вся лестница — вопрос графика «в какую полосу пришло», и срезать её по
 * данным значило бы убрать с глаз полосу, куда человек, возможно, вернулся.
 * Но открытая крайняя полоса (Т-бал 80–200, −14–44,9) шире средних в
 * десяток раз: поле во всю её ширину оставляет средним полосам по десять
 * пикселей. Такой край срезается до двух средних полос за границей (и не
 * ближе данных), и срез отмечается. Обычные лестницы (PHQ-9, AUDIT, WHO-5)
 * этим правилом не задеты: их крайние полосы не больше четырёх средних.
 */
/**
 * Лестница из полос-точек: каждая полоса — одно значение (ступени CGI-S и
 * CGI-I, 1–7). Граница между ними — посередине, и крайние полосы от края
 * оси до границы вышли бы вдвое уже средних; поэтому у такой лестницы ось
 * шире на полшага с каждой стороны, а деления — сами значения.
 */
export function pointLadder(rungs: readonly Rung[]): boolean {
  return rungs.length > 1 && rungs.every((r) => r.min === r.max);
}

/** Деления оси для лестницы: края области и начала полос; у полос-точек — сами значения */
export function ladderTicks(rungs: readonly Rung[], lo: number, hi: number): number[] {
  const sorted = sortRungs(rungs);
  const raw = pointLadder(sorted) ? sorted.map((r) => r.min) : [lo, ...sorted.slice(1).map((r) => r.min), hi];
  return raw.filter((v, i, a) => v >= lo && v <= hi && a.indexOf(v) === i);
}

export function courseDomain(
  rungs: readonly Rung[],
  values: readonly number[],
  max?: number | null,
): { lo: number; hi: number; cut: { lo: boolean; hi: boolean } } {
  const sorted = sortRungs(rungs);
  if (pointLadder(sorted)) {
    const step = Math.min(...boundaries(sorted).map((c, i) => c - sorted[i]!.min));
    const lo = Math.min(sorted[0]!.min - step, ...values);
    const hi = Math.max(sorted.at(-1)!.max + step, ...values);
    return { lo, hi, cut: { lo: false, hi: false } };
  }
  const d = ladderDomain(sorted, values, max);
  let lo = d.lo;
  /*
   * Верх шкалы выше края лестницы (полосы демо-скрининга — до 21, а
   * максимум шкалы — 22) — ось до верха шкалы: иначе в шапке «15 з 22», а у
   * оси «0–21», и замер в 22 ушёл бы за край поля.
   */
  let hi = max != null && max > d.hi ? max : d.hi;
  const cut = { lo: false, hi: false };
  const cuts = boundaries(sorted);
  if (cuts.length >= 2 && values.length) {
    const unit = median(cuts.slice(1).map((c, i) => c - cuts[i]!));
    const vmin = Math.min(...values);
    const vmax = Math.max(...values);
    /* край среза — круглым числом: «105», а не «101,95» у оси */
    const grain = unit >= 5 ? 5 : unit >= 1 ? 1 : 0;
    const up = (v: number) => (grain ? Math.ceil(v / grain) * grain : v);
    const down = (v: number) => (grain ? Math.floor(v / grain) * grain : v);
    if (unit > 0 && hi - cuts.at(-1)! > 4 * unit) {
      hi = Math.min(hi, up(Math.max(vmax, cuts.at(-1)! + 2 * unit)));
      cut.hi = hi < d.hi || (max != null && hi < max);
    }
    if (unit > 0 && cuts[0]! - lo > 4 * unit) {
      lo = Math.max(lo, down(Math.min(vmin, cuts[0]! - 2 * unit)));
      cut.lo = lo > d.lo;
    }
  }
  return { lo, hi: hi > lo ? hi : lo + 1, cut };
}

/**
 * Раскладка курса: области по времени и значению, деления, события дорожки
 * и сигналы на замерах.
 *
 * «Сьогодні» на оси нет: линия «сьогодні» почти всегда совпадала с
 * последним замером (меряют в день приёма) и читалась как ещё одна
 * граница. Сколько прошло с замера, говорит дата под ним и подсказка;
 * будущие приёмы — пустые круги дорожки.
 */
/**
 * События дорожки — только около курса: за неделю до первого замера и до
 * двух месяцев после последнего (следующие приёмы). Приём трёхлетней
 * давности растянул бы ось так, что курс стал бы точкой. Сигналы на дорожку
 * не идут — они стоят на своих замерах.
 */
export function laneEvents(points: readonly Pick<CoursePoint, "t">[], events: readonly CourseEvent[]): CourseEvent[] {
  if (!points.length) return [];
  const ts = points.map((p) => p.t);
  const first = Math.min(...ts);
  const last = Math.max(...ts);
  return events.filter((e) => e.kind !== "signal" && e.t >= first - 7 * DAY_MS && e.t <= last + 60 * DAY_MS);
}

/**
 * Сигналы на замерах курса: сигнал встаёт на замер, который его поднял
 * (`responseId`), и только на график своей шкалы — у сигнала по полосе есть
 * её код, у сигнала по ответу на пункт нет (тот встаёт на все шкалы
 * замера). Без прохождения или с чужим — не на этом графике: сигнал PHQ-9
 * того же дня на оси GAD-7 читался бы как сигнал GAD-7.
 */
export function signalsOn(
  points: readonly Pick<CoursePoint, "key">[],
  events: readonly CourseEvent[],
  scaleCode?: string | null,
): Map<number, CourseEvent[]> {
  const index = new Map(points.map((p, i) => [p.key, i] as const));
  const out = new Map<number, CourseEvent[]>();
  for (const e of events) {
    if (e.kind !== "signal" || !e.responseId) continue;
    if (e.scaleCode && scaleCode && e.scaleCode !== scaleCode) continue;
    const i = index.get(e.responseId);
    if (i === undefined) continue;
    out.set(i, [...(out.get(i) ?? []), e]);
  }
  return out;
}

export function courseLayout(
  points: readonly CoursePoint[],
  rungs: readonly Rung[],
  events: readonly CourseEvent[],
  max?: number | null,
  scaleCode?: string | null,
): CourseLayout {
  const ts = points.map((p) => p.t);
  const first = Math.min(...ts);
  const last = Math.max(...ts);
  const lane = laneEvents(points, events);
  const t0 = Math.min(first, ...lane.map((e) => e.t));
  const t1raw = Math.max(last, ...lane.map((e) => e.t));
  const span = t1raw - t0;
  /* одна точка без событий — неделя в обе стороны, иначе делить не на что */
  const pad = span > 0 ? span * 0.04 : 7 * DAY_MS;

  const signals = signalsOn(points, events, scaleCode);

  const sorted = sortRungs(rungs);
  const values = points.map((p) => p.value);
  let lo: number;
  let hi: number;
  let ticks: number[];
  let cut = { lo: false, hi: false };
  if (sorted.length) {
    const d = courseDomain(sorted, values, max);
    ({ lo, hi, cut } = d);
    ticks = ladderTicks(sorted, lo, hi);
  } else {
    const top = Math.max(max ?? 0, ...values);
    /* баллы без лестницы — чаще целые: деления тогда тоже целые */
    const axis = axisFor({ lo: 0, hi: top, integer: values.every((v) => Number.isInteger(v)) && (max == null || Number.isInteger(max)) });
    lo = axis.min;
    hi = Math.max(axis.max, top);
    ticks = axis.ticks;
  }

  return { t0: t0 - pad, t1: t1raw + pad, lo, hi: hi > lo ? hi : lo + 1, ticks, cut, lane, signals };
}

/* ─────────── подсказка замера и шапка ─────────── */

export interface PointTip {
  point: CoursePoint;
  /** Полоса замера словом */
  band: { label: string; severity: Severity } | null;
  /** Границы этой полосы «від — до» по лестнице; null — лестница о ней не знает */
  range: { min: number; max: number } | null;
  /** Первый замер курса — база, от которой меряется сдвиг */
  baseline: boolean;
  last: boolean;
  /** Сдвиг от старта и его слово; null — у старта или несравнимо */
  fromStart: { delta: number; verdict: ChangeVerdict; since: string } | null;
  /** Почему со стартом не сравнивается */
  incomparable: Incomparable | null;
  /** Сдвиг от предыдущего замера; у второго замера его нет — он совпал бы со сдвигом от старта */
  fromPrev: { delta: number; label: string } | null;
  /** Сигналы риска, которые поднял этот замер */
  signals: CourseEvent[];
}

/**
 * Что сказать о замере: значение, полоса словом, сдвиг от старта с его
 * значущістю, сдвиг от предыдущего, сигналы этого замера. «Каждое число — со
 * сравнением и смыслом» (KIT.md § 2).
 */
export function pointTip(
  points: readonly CoursePoint[],
  i: number,
  rungs: readonly Rung[],
  rc: number | null,
  better: Better | null,
  signals: readonly CourseEvent[] = [],
): PointTip | null {
  const p = points[i];
  if (!p) return null;
  const hit = rungOf(sortRungs(rungs), p.value);
  const band = p.band ?? (hit ? { label: hit.label, severity: hit.severity } : null);
  const base = points[0]!;
  const prev = i > 0 ? points[i - 1]! : null;
  const incomparable = i > 0 ? (p.incomparable ?? null) : null;
  return {
    point: p,
    band,
    range: hit && band && hit.label === band.label ? { min: hit.min, max: hit.max } : null,
    baseline: i === 0,
    last: i === points.length - 1,
    fromStart:
      i > 0 && !incomparable ? { delta: p.value - base.value, verdict: changeVerdict(p.value - base.value, rc, better), since: base.label } : null,
    incomparable,
    /* от предыдущего — со второго сдвига: первый сдвиг от предыдущего и есть сдвиг от старта */
    fromPrev: prev && i > 1 ? { delta: p.value - prev.value, label: prev.label } : null,
    signals: [...signals],
  };
}

/** Полосы лестницы с их краями на оси значений — от края области до границы и до края */
export function bandSpans(rungs: readonly Rung[], lo: number, hi: number): { rung: Rung; from: number; to: number }[] {
  const sorted = sortRungs(rungs);
  const cuts = boundaries(sorted);
  return sorted
    .map((rung, i) => ({
      rung,
      from: Math.max(lo, i === 0 ? lo : cuts[i - 1]!),
      to: Math.min(hi, i === sorted.length - 1 ? hi : cuts[i]!),
    }))
    .filter((s) => s.to > s.from);
}

/* ─────────── подписи ─────────── */

/** Прямоугольник на поле графика: x0, y0 — левый верхний угол */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const hits = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Первое место для подписи, где она ничего не закрывает: ни замер, ни
 * линию, ни число у замера, ни другую подпись, — и не вылезает за поле.
 * Места перебираются в порядке предпочтения. Ни одного свободного — null:
 * подпись не рисуется, число остаётся в подсказке и в таблице.
 */
export function freeSpot<T extends Box>(candidates: readonly T[], obstacles: readonly Box[], field: Box): T | null {
  for (const c of candidates) {
    if (c.x0 < field.x0 || c.x1 > field.x1 || c.y0 < field.y0 || c.y1 > field.y1) continue;
    if (!obstacles.some((o) => hits(c, o))) return c;
  }
  return null;
}

/**
 * Порядок, в котором замеры получают число: последний (где человек сейчас),
 * первый (откуда начали), наибольший и наименьший, дальше — переломы хода
 * (замер выше или ниже обоих соседей), потом остальные с конца. Число
 * ставится, только если ни на что не налезает (placeValues в course.tsx):
 * на коротком курсе подписаны все, на длинном — края, крайние и переломы.
 */
export function valueOrder(values: readonly number[]): number[] {
  const n = values.length;
  if (!n) return [];
  let mn = 0;
  let mx = 0;
  values.forEach((v, i) => {
    if (v < values[mn]!) mn = i;
    if (v > values[mx]!) mx = i;
  });
  const turns = values
    .map((v, i) => ({ i, d: i > 0 && i < n - 1 ? Math.min(Math.abs(v - values[i - 1]!), Math.abs(v - values[i + 1]!)) : 0, v }))
    .filter(({ i, v }) => i > 0 && i < n - 1 && (v - values[i - 1]!) * (v - values[i + 1]!) > 0)
    .sort((a, b) => b.d - a.d)
    .map(({ i }) => i);
  const rest = values.map((_, i) => n - 1 - i);
  return [...new Set([n - 1, 0, mx, mn, ...turns, ...rest])];
}

/**
 * Подписи дат под осью без наложения: сначала последняя, потом первая,
 * потом остальные с конца — каждая, только если не налезает на уже
 * поставленные. `width` — оценка ширины подписи в пикселях.
 */
export function placeLabels(xs: readonly number[], widths: readonly number[], gap = 8): Set<number> {
  const order = xs.map((_, i) => i);
  const last = xs.length - 1;
  order.sort((a, b) => (a === last ? -1 : b === last ? 1 : a === 0 ? -1 : b === 0 ? 1 : b - a));
  const placed: { from: number; to: number }[] = [];
  const out = new Set<number>();
  for (const i of order) {
    const from = xs[i]! - widths[i]! / 2 - gap / 2;
    const to = xs[i]! + widths[i]! / 2 + gap / 2;
    if (placed.some((p) => from < p.to && to > p.from)) continue;
    placed.push({ from, to });
    out.add(i);
  }
  return out;
}

/* ─────────── подписи полос ─────────── */

/**
 * Перенос подписи по словам в заданную ширину. Слово длиннее строки
 * остаётся целым на своей строке: ширина колонки выбирается не меньше
 * самого длинного слова (labelColumn), и резать слово не приходится.
 */
/* слова делит обычный пробел: неразрывный («24–38 %») держит своё вместе */
const SPACE = /[ \t\n\r]+/;

export function wrapWords(text: string, width: number, measure: (s: string) => number): string[] {
  const words = text.split(SPACE).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && measure(next) > width) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Ширина колонки подписей полос: столько строк, сколько даёт самая широкая
 * допустимая колонка (`max`), — и самая узкая ширина с тем же числом строк.
 * Не уже самого длинного слова и не уже `min`. Подпись в одну строку
 * читается быстрее двух, но колонка не шире, чем это нужно; не уложились в
 * `lines` строк и при `max` — `max`: подпись встанет в три строки, но
 * целиком (многоточие «Депресія умеренной тяжес…» прятало ровно то, ради
 * чего полосы подписаны).
 */
export function labelColumn(texts: readonly string[], measure: (s: string) => number, min: number, max: number, lines = 2): number {
  const top = Math.max(min, max);
  const longestWord = Math.max(0, ...texts.flatMap((t) => t.split(SPACE).map(measure)));
  const count = (w: number) => texts.reduce((n, t) => n + wrapWords(t, w, measure).length, 0);
  if (!texts.length || texts.some((t) => wrapWords(t, top, measure).length > lines)) return top;
  const best = count(top);
  let a = Math.min(top, Math.max(min, Math.ceil(longestWord)));
  if (count(a) === best) return a;
  let b = top;
  /* строк с шириной не прибавляется — ширина ищется делением пополам, в целых пикселях */
  while (b - a > 1) {
    const m = Math.floor((a + b) / 2);
    if (count(m) === best) b = m;
    else a = m;
  }
  return b;
}

/**
 * Блоки подписей в колонке без наложения.
 *
 * Каждый блок хочет стоять серединой на своей полосе (`want`); блоки идут
 * сверху вниз в том же порядке, что полосы. Проход сверху раздвигает
 * налезающие, проход снизу возвращает то, что вылезло за нижний край;
 * не помещаются вовсе — колонка выходит за верх, а не наезжает сама на себя.
 * Возвращает верхний край каждого блока.
 */
export function stackBlocks(blocks: readonly { want: number; h: number }[], top: number, bottom: number, gap = 2): number[] {
  const ys = blocks.map((b) => b.want - b.h / 2);
  for (let i = 0; i < ys.length; i++) {
    const floor = i ? ys[i - 1]! + blocks[i - 1]!.h + gap : top;
    ys[i] = Math.max(ys[i]!, floor);
  }
  for (let i = ys.length - 1; i >= 0; i--) {
    const ceil = i === ys.length - 1 ? bottom : ys[i + 1]! - gap;
    ys[i] = Math.min(ys[i]!, ceil - blocks[i]!.h);
  }
  return ys;
}

/* ─────────── дорожка событий ─────────── */

/**
 * Значки дорожки без наложения: событие одного дня (приём и заключение после
 * него) раздвигается на `gap` вправо, а у правого края — влево. Порядок
 * событий сохраняется: значок не перепрыгивает соседа.
 */
export function dodge(xs: readonly number[], gap: number, lo: number, hi: number): number[] {
  const out = xs.map((x) => Math.min(hi, Math.max(lo, x)));
  for (let i = 1; i < out.length; i++) if (out[i]! - out[i - 1]! < gap) out[i] = out[i - 1]! + gap;
  for (let i = out.length - 1; i >= 0; i--) {
    const ceil = i === out.length - 1 ? hi : out[i + 1]! - gap;
    if (out[i]! > ceil) out[i] = ceil;
  }
  return out;
}

/* ─────────── сетка графиков ─────────── */

/**
 * Сколько графиков курса встаёт в ряд: не уже `min` пикселей на график (у
 * графика уже этого поле курса сжимается колонкой подписей полос), не больше
 * `max` в ряд и не больше, чем графиков.
 */
export function courseColumns(width: number, count: number, min = 420, max = 3, gap = 16): number {
  const fit = Math.max(1, Math.floor((width + gap) / (min + gap)));
  return Math.max(1, Math.min(fit, max, count));
}

/**
 * Ширина каждого графика в сетке из шести долей — так, чтобы последний ряд
 * не оставался пустым наполовину: одинокий последний график — на всю
 * ширину, два последних в ряду на три — по половине. Возвращает число долей
 * из шести на каждый график.
 */
export function gridSpans(count: number, cols: number): number[] {
  const c = Math.max(1, Math.min(cols, 3));
  const each = 6 / c;
  const spans = Array.from({ length: count }, () => each);
  const tail = count % c;
  if (tail) for (let i = count - tail; i < count; i++) spans[i] = 6 / tail;
  return spans;
}

/* ─────────── имена ─────────── */

/**
 * Что меряет методика и как она называется коротко — из названия:
 * «Депресія (PHQ-9)» → «Депресія» и «PHQ-9»; «СР-45. Схильність до
 * суїцидальних реакцій» → «Схильність до суїцидальних реакцій» и «СР-45»;
 * без кода — название целиком и кода нет. Шапка графика курса — «Депресія ·
 * PHQ-9»: и что меряли, и чем.
 */
export function methodNames(surveyTitle: string): { measure: string; code: string | null } {
  const title = surveyTitle.trim();
  /* в скобках — код, а не пометка: с цифрой («PHQ-9») или прописными («ISI»); «(демо)» — не код */
  const paren = /^(.*?)\s*\(([^()]{2,16})\)\s*$/.exec(title);
  if (paren && (/\d/.test(paren[2]!) || paren[2] === paren[2]!.toUpperCase())) return { measure: paren[1]!.trim() || title, code: paren[2]!.trim() };
  const dot = /^([^\s.:]{2,12})[.:]\s+(.+)$/.exec(title);
  if (dot && /\d/.test(dot[1]!)) return { measure: dot[2]!.trim(), code: dot[1]! };
  return { measure: title, code: null };
}

/**
 * Шапка графика курса для шкалы методики: у методики с одной шкалой —
 * «Депресія · PHQ-9» (что меряет методика и её код), у многошкальной —
 * «Тривога · Скринінг емоційного стану»: шкала и методика, которой она
 * принадлежит. Служебный код шкалы («PHQ», «anxiety») человеку не
 * показывается.
 */
export function courseNames(surveyTitle: string, scaleTitle: string, single: boolean): { measure: string; method: string | null } {
  const m = methodNames(surveyTitle);
  return single ? { measure: m.measure, method: m.code } : { measure: scaleTitle, method: m.code ?? surveyTitle };
}
