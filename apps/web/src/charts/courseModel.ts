import {
  comparability,
  measurementError,
  polarityOfBands,
  type ComparableMark,
  type DynamicsPoint,
  type Incomparable,
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
 * где кончается «межа похибки», какое слово стоит у сдвига, какие события
 * попадают на ось. Компонент (course.tsx) только рисует то, что вернули эти
 * функции, — и тест (apps/web/test/courseChart.test.tsx) проверяет и то и
 * другое.
 *
 * Откуда числа — только из приложения:
 *
 *   — замеры: динамика пациента (GET /api/dynamics/respondents/:id), по
 *     точке на завершённое прохождение;
 *   — полосы: лестница шкалы методики (bands), та же, что у линейки;
 *   — «краще ↓ / ↑»: полярность по самим полосам (polarityOfBands) — флага
 *     в справочнике нет, и он разошёлся бы с полосами;
 *   — порог надёжной зміни: MDC95 = 1,96·√2·SEM (measurementError в
 *     shared/rci.ts) — тот же порог, что |RCI| > 1,96, только в баллах шкалы;
 *   — события: хронология пациента (GET /api/timeline/:id) — приёмы со
 *     статусом и сигналы риска.
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
}

export type CourseEventKind = "session" | "noshow" | "planned" | "signal";

export interface CourseEvent {
  key: string;
  t: number;
  kind: CourseEventKind;
  /** Подпись даты */
  label: string;
  /** Что за событие словами: подпись сигнала, специалист приёма */
  detail?: string | null;
}

export type Better = "down" | "up";

/* ─────────── сдвиг и его слово ─────────── */

export type ChangeVerdict = "better" | "worse" | "changed" | "within" | "unknown";

/**
 * Слово для сдвига от старта.
 *
 * Правило Jacobson–Truax в баллах: сдвиг надёжен, когда по модулю больше
 * порога (|RCI| > 1,96 ⇔ |Δ| > MDC95), ровно на пороге — ещё «у межах
 * похибки», как и в classifyChange. Без порога — «unknown»: похибку не из
 * чего оценить, и слово «у межах» было бы неправдой. Без полярности —
 * «changed»: сдвиг надёжный, но назвать его улучшением нельзя.
 */
export function changeVerdict(delta: number, rc: number | null, better: Better | null): ChangeVerdict {
  if (rc === null || !Number.isFinite(rc) || rc <= 0) return "unknown";
  if (Math.abs(delta) <= rc) return "within";
  if (better === null) return "changed";
  const improved = better === "down" ? delta < 0 : delta > 0;
  return improved ? "better" : "worse";
}

/** «Краще ↓ / ↑» по лестнице: тяжесть растёт с баллом — лучше вниз; немонотонная — неизвестно */
export function betterOf(rungs: readonly Rung[]): Better | null {
  const higherIsWorse = polarityOfBands(rungs.map((r) => ({ minScore: r.min, maxScore: r.max, severity: r.severity })));
  return higherIsWorse === null ? null : higherIsWorse ? "down" : "up";
}

/**
 * Порог надёжной зміни в баллах шкалы.
 *
 * Из основы RCI (SD и α выборки), если сервер её отдал, — тем же расчётом,
 * что и всюду (measurementError); иначе из SEM: MDC95 = 1,96·√2·SEM. Нет ни
 * того ни другого — null, и зона похибки не рисуется: придуманная полоса
 * выглядит как знание.
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
  /** Нормировка последнего замера: подпись единиц у оси */
  normalization: DynamicsPoint["normalization"] | null;
}

/**
 * Динамика одной шкалы → данные графика курса.
 *
 * `rungs` — лестница шкалы методики (bands из описания методики или из
 * аналитики: у динамики её нет). Порог из старта, сделанного недостоверным
 * протоколом, не рисуется: межа похибки от числа, которому нельзя верить, —
 * та же выдумка.
 */
export function courseFromDynamics(
  scale: Pick<ScaleDynamics, "points" | "sem" | "reliableChange">,
  rungs: readonly Rung[],
  formatDay: (iso: string) => string = day,
): CourseData {
  const sorted = [...scale.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  const ladder = sortRungs(rungs);
  const first = sorted[0];
  const points = sorted.map((p, i) => {
    const hit = rungOf(ladder, p.rawScore);
    return {
      key: p.responseId,
      t: Date.parse(p.submittedAt),
      label: formatDay(p.submittedAt),
      value: p.rawScore,
      band: p.severity && p.bandLabel ? { label: p.bandLabel, severity: p.severity } : hit ? { label: hit.label, severity: hit.severity } : null,
      incomparable: i && first ? comparability(markOf(first), markOf(p)) : null,
    };
  });
  return {
    points,
    rungs: ladder,
    rc: first && first.reliable === false ? null : reliableThreshold(scale),
    better: betterOf(ladder),
    normalization: sorted.at(-1)?.normalization ?? null,
  };
}

/** Строка хронологии пациента — то, что отдаёт GET /api/timeline/:userId */
export interface TimelineLike {
  id: string;
  kind: string;
  at: string;
  title: string;
  detail?: string | null;
}

/**
 * Хронология → события оси курса.
 *
 * Приём со статусом «done», «arrived», «in_progress» — проведённая сесія;
 * «no_show» — неявка; «booked» и «confirmed» — запланированная (в прошлом —
 * неотмеченная: её не считают ни проведённой, ни сорванной). Сигнал — строка
 * тревоги. Отменённые приёмы сервер в хронологию не отдаёт.
 */
export function courseEventsFromTimeline(items: readonly TimelineLike[], formatDay: (iso: string) => string = day): CourseEvent[] {
  const out: CourseEvent[] = [];
  for (const it of items) {
    const t = Date.parse(it.at);
    if (!Number.isFinite(t)) continue;
    const base = { key: it.id, t, label: formatDay(it.at) };
    if (it.kind === "alert") out.push({ ...base, kind: "signal", detail: it.title || null });
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
  /** Сегодня на оси — только если курс до него дотягивается */
  today: number | null;
  events: CourseEvent[];
  /** Номер сессии у проведённых и будущих запланированных */
  sessionNo: Map<string, number>;
}

/**
 * Где «сьогодні» уместно на оси: курс не старше месяца от последнего
 * замера или трети своей длины. Пациент, которого не мерили полгода,
 * получил бы пустое поле шириной в полгода, а сам курс сжался бы в левый
 * край — сколько прошло с последнего замера, скажет подсказка.
 */
export function todayFits(points: readonly CoursePoint[], now: number): boolean {
  if (!points.length) return false;
  const first = points[0]!.t;
  const last = points.at(-1)!.t;
  return now >= first && now - last <= Math.max(30 * DAY_MS, 0.35 * (last - first));
}

export function courseLayout(points: readonly CoursePoint[], rungs: readonly Rung[], events: readonly CourseEvent[], now: number | null, max?: number | null): CourseLayout {
  const ts = points.map((p) => p.t);
  const first = Math.min(...ts);
  const last = Math.max(...ts);
  const today = now !== null && todayFits(points, now) ? now : null;
  const right = Math.max(last, today ?? last);
  /*
   * События — только около курса: за неделю до первого замера и до двух
   * месяцев после правого края (следующие сессии). Приём трёхлетней
   * давности растянул бы ось так, что курс стал бы точкой.
   */
  const near = events.filter((e) => e.t >= first - 7 * DAY_MS && e.t <= right + 60 * DAY_MS);
  const t0 = Math.min(first, ...near.map((e) => e.t));
  const t1raw = Math.max(right, ...near.map((e) => e.t));
  const span = t1raw - t0;
  /* одна точка без событий — неделя в обе стороны, иначе делить не на что */
  const pad = span > 0 ? span * 0.04 : 7 * DAY_MS;

  const sorted = sortRungs(rungs);
  const values = points.map((p) => p.value);
  let lo: number;
  let hi: number;
  let ticks: number[];
  if (sorted.length) {
    const d = ladderDomain(sorted, values, max);
    lo = d.lo;
    /*
     * Верх шкалы выше края лестницы (полосы демо-скрининга — до 21, а
     * максимум шкалы — 22) — ось до верха шкалы: иначе под графиком «15 з 22»,
     * а у оси «бали 0–21», и замер в 22 ушёл бы за край поля.
     */
    hi = max != null && max > d.hi ? max : d.hi;
    ticks = [lo, ...sorted.slice(1).map((r) => r.min), hi].filter((v, i, a) => v >= lo && v <= hi && a.indexOf(v) === i);
  } else {
    const top = Math.max(max ?? 0, ...values);
    /* баллы без лестницы — чаще целые: деления тогда тоже целые */
    const axis = axisFor({ lo: 0, hi: top, integer: values.every((v) => Number.isInteger(v)) && (max == null || Number.isInteger(max)) });
    lo = axis.min;
    hi = Math.max(axis.max, top);
    ticks = axis.ticks;
  }

  const sessionNo = new Map<string, number>();
  let n = 0;
  for (const e of near) {
    if (e.kind === "session" || (e.kind === "planned" && (now === null || e.t > now))) sessionNo.set(e.key, ++n);
  }

  return { t0: t0 - pad, t1: t1raw + pad, lo, hi: hi > lo ? hi : lo + 1, ticks, today, events: near, sessionNo };
}

/* ─────────── подсказка замера ─────────── */

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
  fromStart: { delta: number; verdict: ChangeVerdict } | null;
  /** Почему со стартом не сравнивается */
  incomparable: Incomparable | null;
  /** Сдвиг от предыдущего замера */
  fromPrev: { delta: number; label: string } | null;
}

/**
 * Что сказать о замере под курсором: значение, полоса словом, сдвиг от
 * старта с его надёжностью и сдвиг от предыдущего. «Каждое число — со
 * сравнением и смыслом» (KIT.md § 2).
 */
export function pointTip(points: readonly CoursePoint[], i: number, rungs: readonly Rung[], rc: number | null, better: Better | null): PointTip | null {
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
    fromStart: i > 0 && !incomparable ? { delta: p.value - base.value, verdict: changeVerdict(p.value - base.value, rc, better) } : null,
    incomparable,
    fromPrev: prev ? { delta: p.value - prev.value, label: prev.label } : null,
  };
}

/** Полосы лестницы с их краями на оси значений — от края области до границы и до края */
export function bandSpans(rungs: readonly Rung[], lo: number, hi: number): { rung: Rung; from: number; to: number }[] {
  const sorted = sortRungs(rungs);
  const cuts = boundaries(sorted);
  return sorted.map((rung, i) => ({
    rung,
    from: i === 0 ? lo : cuts[i - 1]!,
    to: i === sorted.length - 1 ? hi : cuts[i]!,
  }));
}

/** Какие замеры подписать числом: все, пока их немного; иначе края и крайние значения */
export function labelledPoints(values: readonly number[]): Set<number> {
  if (values.length <= 8) return new Set(values.map((_, i) => i));
  const out = new Set([0, values.length - 1]);
  let mn = 0;
  let mx = 0;
  values.forEach((v, i) => {
    if (v < values[mn]!) mn = i;
    if (v > values[mx]!) mx = i;
  });
  out.add(mn);
  out.add(mx);
  return out;
}

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
 * Места перебираются в порядке предпочтения (как у набора: сначала у
 * левого края в своей полосе, потом у её другой кромки, потом дальше).
 * Ни одного свободного — null: подпись не рисуется, её смысл остаётся в
 * легенде и в подсказке.
 */
export function freeSpot<T extends Box>(candidates: readonly T[], obstacles: readonly Box[], field: Box): T | null {
  for (const c of candidates) {
    if (c.x0 < field.x0 || c.x1 > field.x1 || c.y0 < field.y0 || c.y1 > field.y1) continue;
    if (!obstacles.some((o) => hits(c, o))) return c;
  }
  return null;
}

/**
 * Где подписать «сьогодні» над полем.
 *
 * По центру своей линии, как в наборе. Но в той же строке слева стоит
 * подпись оси («бали 0–25, краще ↑»), и на узком графике с сессиями,
 * назначенными вперёд, линия «сьогодні» уходит к левому краю — подписи
 * наезжали одна на другую. Тогда подпись встаёт флажком справа от линии, а
 * если линия проходит под самой подписью оси — сразу за её концом. За
 * правый край графика не выходит.
 *
 * `titleEnd` — правый край подписи оси, `right` — правый край графика.
 */
export function todayLabelAt(
  lineX: number,
  labelW: number,
  titleEnd: number,
  right: number,
  gap = 8,
): { x: number; anchor: "middle" | "start" } {
  if (lineX - labelW / 2 >= titleEnd + gap) return { x: Math.min(lineX, right - labelW / 2), anchor: "middle" };
  return { x: Math.min(Math.max(lineX + 4, titleEnd + gap), right - labelW), anchor: "start" };
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
