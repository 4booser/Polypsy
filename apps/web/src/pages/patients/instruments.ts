import {
  instrumentCode,
  type DynamicsPoint,
  type RespondentDynamics,
  type ScaleDynamics,
  type Severity,
} from "@quizzy/shared";
import { betterOf, reliableThreshold, type Better } from "../../charts/courseModel";
import { sortRungs, type Rung } from "../../charts/ladder";
import { dayKey } from "../../format";

/*
 * Методики человека так, как их читают на экранах пациента 2.0: быстрый
 * просмотр в реестре, «Результати за методиками» справы, «Динаміка».
 *
 * Источник один — динамика (GET /api/dynamics/respondents/:id): точки по
 * шкалам, сравнимость концов, RCI и его основа, SEM, приведение версий,
 * полосы шкалы. Здесь ничего не досчитывается сверх неё, кроме того, что
 * она прямо подразумевает: порог надёжной зміни в баллах (MDC95 — тот же,
 * что |RCI| > 1,96) и «краще ↓ / ↑» по полярности полос.
 */

export interface InstrumentScale {
  scale: ScaleDynamics;
  /** Лестница полос шкалы (последней версии), по возрастанию */
  rungs: Rung[];
  /** «краще ↓ / ↑»; null — полос нет или они немонотонны */
  better: Better | null;
  /** Порог надёжной зміни в единицах шкалы; null — похибку не из чего оценить */
  threshold: number | null;
  first: DynamicsPoint;
  last: DynamicsPoint;
  /** Значения до последнего, по времени: «було 19 → 16» */
  history: number[];
}

export interface Instrument {
  surveyId: string;
  /** «PHQ-9» из названия, иначе само название (код шкалы «F» или «sleep» о методике не говорит) */
  code: string;
  title: string;
  responseCount: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Шкала, которой методика говорит о состоянии одним числом */
  main: InstrumentScale;
  /** Все шкалы методики, главная первой */
  scales: InstrumentScale[];
}

const RANK: Record<Severity, number> = { none: 0, mild: 1, moderate: 2, severe: 3 };

function scaleOf(scale: ScaleDynamics): InstrumentScale | null {
  const points = [...scale.points].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) return null;
  const rungs = sortRungs((scale.bands ?? []).map((b) => ({ min: b.min, max: b.max, label: b.label, severity: b.severity })));
  return {
    scale: { ...scale, points },
    rungs,
    better: rungs.length ? betterOf(rungs) : null,
    threshold: reliableThreshold(scale),
    first,
    last,
    history: points.slice(0, -1).map((p) => p.rawScore),
  };
}

/**
 * Главная шкала: единственная, иначе та, у которой последний замер тяжелее
 * (методика из десятка шкал одним числом не пересказывается — в строке
 * стоит то, что требует внимания), при равенстве — первая.
 */
function mainOf(scales: InstrumentScale[]): InstrumentScale {
  return scales.reduce((best, s) =>
    RANK[s.last.severity ?? "none"] > RANK[best.last.severity ?? "none"] ? s : best,
  );
}

export function instrumentsOf(d: RespondentDynamics | null | undefined): Instrument[] {
  if (!d) return [];
  const out: Instrument[] = [];
  for (const sv of d.surveys) {
    const scales = sv.scales.map(scaleOf).filter((s): s is InstrumentScale => s !== null);
    if (!scales.length) continue;
    const main = mainOf(scales);
    out.push({
      surveyId: sv.surveyId,
      code: instrumentCode(sv.title, sv.title),
      title: sv.title,
      responseCount: sv.responseCount,
      firstAt: sv.firstAt,
      lastAt: sv.lastAt,
      main,
      scales: [main, ...scales.filter((s) => s !== main)],
    });
  }
  /* свежий замер — выше: о нём и спрашивают первым */
  return out.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.title.localeCompare(b.title));
}

/** Даты замеров методики по возрастанию — колонки таблицы «Результати за методиками» */
export function measureDates(list: readonly Instrument[]): string[] {
  const days = new Set<string>();
  for (const i of list) for (const p of i.main.scale.points) days.add(dayKey(p.submittedAt));
  return [...days].sort();
}

/** Значение точки на день «YYYY-MM-DD» по часам консоли (последний замер дня); нет — null */
export function valueOn(s: InstrumentScale, dayIso: string): DynamicsPoint | null {
  const hits = s.scale.points.filter((p) => dayKey(p.submittedAt) === dayIso);
  return hits.at(-1) ?? null;
}

/**
 * Изменение от старта — только если концы сравнимы (сервер отдаёт delta
 * null при разных версиях, единицах или недостоверном протоколе).
 */
export function changeOf(s: InstrumentScale): number | null {
  const d = s.scale.delta;
  return d === null || d === undefined ? null : Math.round(d * 100) / 100;
}

/**
 * Изменение от старта в единицах экрана: доля — процентными пунктами,
 * остальное — с одним знаком после запятой.
 */
export function shownDelta(s: InstrumentScale, delta: number): number {
  return s.last.normalization === "ratio" ? Math.round(delta * 100) : Math.round(delta * 10) / 10;
}

/**
 * Порог надёжной зміни в единицах экрана. У сырого балла (целые суммы)
 * — вверх до целого: сдвиг на 4 при пороге 3,6 надёжен, на 3 — нет, и
 * «поріг 4» говорит ровно это без десятых, которых у балла не бывает.
 */
export function shownThreshold(s: InstrumentScale): number | null {
  const t = s.threshold;
  if (t === null) return null;
  if (s.last.normalization === "ratio") return Math.ceil(t * 100 - 1e-9);
  if (!s.last.normalization || s.last.normalization === "raw") return Math.ceil(t - 1e-9);
  return Math.round(t * 10) / 10;
}

/** Короткое имя методики для узкой подписи: длинное название обрезается многоточием */
export function shortCode(code: string, max = 14): string {
  return code.length <= max ? code : `${code.slice(0, max - 1).trimEnd()}…`;
}
