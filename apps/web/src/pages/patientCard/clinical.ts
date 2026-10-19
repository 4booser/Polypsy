import type { DynamicsPoint, Incomparable, RespondentDynamics, ResponseDetail, ScaleDynamics } from "@quizzy/shared";
import { betterOf, reliableThreshold, type Better } from "../../charts/courseModel";
import { sortRungs, type Rung } from "../../charts/ladder";
import { shownLimit, shownStep } from "../patients/model";

/*
 * Клиническая часть карточки пациента — чистые функции без React и сети.
 *
 * Здесь решается, что встанет в таблицу методик, на график курса и в
 * таблицу пунктов, какой приём «следующий», какая неявка «свежая» и что
 * случилось «после сессии». Всё — из ответов приложения: динамика
 * (GET /api/dynamics/respondents/:id), прохождения с полосами той версии,
 * что человек видел (GET /api/responses/:id), и хронология
 * (GET /api/timeline/:id). Проверяется без отрисовки:
 * apps/web/test/patientCardClinical.test.ts.
 */

/* ─────────── методики ─────────── */

export interface InstrumentRow {
  key: string;
  surveyId: string;
  surveyTitle: string;
  scaleId: string;
  /**
   * Подпись строки: у методики с одной шкалой — код методики («PHQ-9» из
   * «Депресія (PHQ-9)»), у многошкальной — название шкалы («Тривога»).
   * Код шкалы («PHQ», «anxiety») — служебный идентификатор, человеку его
   * не показываем.
   */
  code: string;
  /** Что меряет: название шкалы у одношкальной, код методики у многошкальной */
  title: string;
  /** Замеры по времени, старые первыми */
  points: DynamicsPoint[];
  /** Сдвиг первый → последний в единицах экрана (у доли — в. п.); null — сравнивать нельзя или замер один */
  delta: number | null;
  /** Порог надёжной зміни (MDC95) в тех же единицах; null — не оценён */
  threshold: number | null;
  /** «Краще ↓ / ↑» — по полярности полос; null — полос нет или немонотонны */
  better: Better | null;
  incomparable: Incomparable | null;
  /** Лестница полос шкалы — из последнего прохождения (та версия, что человек видел) */
  rungs: Rung[];
  scale: ScaleDynamics;
}

/** Лестница полос шкалы из прохождения: полосы той версии, по которой человек отвечал */
export function rungsOf(detail: ResponseDetail | null | undefined, scaleId: string): Rung[] {
  const score = detail?.scores.find((s) => s.scaleId === scaleId);
  if (!score) return [];
  return sortRungs(
    score.bands.map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity })),
  );
}

/** Код методики из названия: «PHQ-9» из «Депресія (PHQ-9)», «СР-45» из «СР-45. Схильність…» */
export function instrumentCode(surveyTitle: string): string {
  /* в скобках — код, а не пометка: с цифрой («PHQ-9») или прописными («ISI»); «(демо)» — не код */
  const paren = /\(([^()]{2,16})\)\s*$/.exec(surveyTitle)?.[1]?.trim();
  if (paren && (/\d/.test(paren) || paren === paren.toUpperCase())) return paren;
  return surveyTitle.split(/[.:]/)[0]!.trim();
}

/** Последнее прохождение методики в динамике — по нему берутся полосы */
export function latestResponseOf(survey: RespondentDynamics["surveys"][number]): string | null {
  let best: DynamicsPoint | null = null;
  for (const sc of survey.scales) {
    for (const p of sc.points) if (!best || Date.parse(p.submittedAt) > Date.parse(best.submittedAt)) best = p;
  }
  return best?.responseId ?? null;
}

/**
 * Строки таблицы методик: по шкале на строку, свежие методики первыми,
 * не больше `limit`. Сдвиг — только у сравнимых концов (incomparable —
 * то же правило, что в динамике и сводке), порог — MDC95 из основы RCI.
 */
export function instrumentRows(
  dynamics: RespondentDynamics | null | undefined,
  details: Record<string, ResponseDetail | null | undefined>,
  limit = 6,
): InstrumentRow[] {
  if (!dynamics) return [];
  const surveys = [...dynamics.surveys].sort((a, b) => Date.parse(b.lastAt ?? "") - Date.parse(a.lastAt ?? ""));
  const rows: InstrumentRow[] = [];
  for (const sv of surveys) {
    const latest = latestResponseOf(sv);
    const detail = latest ? details[latest] : null;
    /* шкалы достоверности («L», «F») говорят о бланке, а не о человеке — в таблицу методик не идут */
    const scales = sv.scales.filter((sc) => {
      const kind = detail?.scores.find((x) => x.scaleId === sc.scaleId)?.kind;
      return sc.points.length > 0 && (!kind || kind === "clinical");
    });
    const single = scales.length === 1;
    const code = instrumentCode(sv.title);
    for (const sc of scales) {
      const points = [...sc.points].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
      const rungs = rungsOf(detail, sc.scaleId);
      const incomparable = sc.incomparable ?? null;
      const first = points[0]!;
      const last = points[points.length - 1]!;
      const threshold = first.reliable === false ? null : reliableThreshold(sc);
      rows.push({
        key: `${sv.surveyId}:${sc.scaleId}`,
        surveyId: sv.surveyId,
        surveyTitle: sv.title,
        scaleId: sc.scaleId,
        code: single ? code : sc.title,
        title: single ? sc.title : code,
        points,
        /*
         * Сдвиг и порог — в единицах экрана, теми же правилами, что «Огляд
         * справи» и «Хто це» (patients/model.ts): у доли — процентные пункты.
         * Прежде доля вычиталась как есть, и 0,29 → 0,49 стояло «+0,2 в. п.»
         * рядом с «49%».
         */
        delta: points.length > 1 && !incomparable ? shownStep(last.rawScore - first.rawScore, last.normalization) : null,
        threshold: threshold === null ? null : shownLimit(threshold, last.normalization),
        better: betterOf(rungs),
        incomparable,
        rungs,
        scale: sc,
      });
      if (rows.length >= limit) return rows;
    }
  }
  return rows;
}

/* ─────────── пункты ─────────── */

export interface ItemRow {
  questionId: string;
  /** Номер пункта в бланке, с единицы */
  n: number;
  title: string;
  /** Балл выбранного варианта на каждом замере; null — ответа нет */
  cells: (number | null)[];
  /** Текст выбранного варианта — для подсказки */
  words: (string | null)[];
  /** Выбран критический вариант (riskFlag) — красная клетка */
  flags: boolean[];
  /** У пункта есть критический вариант (пункт 9 PHQ-9): ненулевой ответ — риск */
  critical: boolean;
}

export interface ItemsGrid {
  columns: { responseId: string; at: string }[];
  rows: ItemRow[];
  /** Верх лестницы: наибольший вес варианта */
  max: number;
  /** Сумма баллов пунктов на замере */
  sums: (number | null)[];
  /** Подписи весов: 0 «зовсім ні» … — по первому пункту последнего замера */
  legend: { value: number; label: string }[];
  /**
   * Веса у вариантов не различаются (у «так / ні» бланков счёт идёт ключом
   * шкалы, а вес варианта — ноль): тогда в клетке — слово ответа, а не балл,
   * и суммы нет.
   */
  categorical: boolean;
}

/** Вес выбранного варианта; без веса или без выбора — null */
function picked(a: ResponseDetail["answers"][number] | undefined): { score: number | null; text: string | null; flag: boolean } {
  if (!a || !a.answered) return { score: null, text: null, flag: false };
  const ids = new Set(a.optionIds ?? []);
  const chosen = a.options.filter((o) => ids.has(o.id));
  if (!chosen.length) return { score: null, text: null, flag: false };
  const scores = chosen.map((o) => o.score).filter((s): s is number => s !== null);
  return {
    score: scores.length ? scores.reduce((x, y) => x + y, 0) : null,
    text: chosen.map((o) => o.text).join(", "),
    flag: chosen.some((o) => o.riskFlag),
  };
}

/**
 * Таблица пунктов методики по замерам (старые слева). Только пункты с
 * весами вариантов: у текстового ответа и у пункта без ключа «балла» нет, и
 * клетка с прочерком на всю строку была бы шумом.
 */
export function itemsGrid(details: readonly ResponseDetail[]): ItemsGrid | null {
  const sorted = [...details]
    .filter((d) => d.submittedAt)
    .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!));
  const latest = sorted[sorted.length - 1];
  if (!latest) return null;
  const scored = latest.answers
    .filter((a) => a.options.length && (a.options.some((o) => o.score !== null) || a.options.some((o) => o.riskFlag)))
    .sort((a, b) => a.position - b.position);
  if (!scored.length) return null;
  const rows: ItemRow[] = scored.map((q, i) => {
    const cells: (number | null)[] = [];
    const words: (string | null)[] = [];
    const flags: boolean[] = [];
    for (const d of sorted) {
      const got = picked(d.answers.find((a) => a.questionId === q.questionId));
      cells.push(got.score);
      words.push(got.text);
      flags.push(got.flag);
    }
    return {
      questionId: q.questionId,
      n: i + 1,
      title: q.title,
      cells,
      words,
      flags,
      critical: q.options.some((o) => o.riskFlag),
    };
  });
  let max = 0;
  const weights = new Set<number>();
  for (const q of scored) {
    for (const o of q.options) {
      if (o.score === null) continue;
      weights.add(o.score);
      if (o.score > max) max = o.score;
    }
  }
  const categorical = weights.size < 2;
  const sums = sorted.map((_, j) => {
    if (categorical) return null;
    const vals = rows.map((r) => r.cells[j]).filter((v): v is number => v !== null && v !== undefined);
    return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
  });
  const first = scored[0]!;
  const legend = categorical
    ? []
    : [...first.options]
        .filter((o) => o.score !== null)
        .sort((a, b) => a.score! - b.score!)
        .map((o) => ({ value: o.score!, label: o.text }));
  return {
    columns: sorted.map((d) => ({ responseId: d.id, at: d.submittedAt! })),
    rows,
    max,
    sums,
    legend,
    categorical,
  };
}

export interface ItemAnswer {
  responseId: string;
  at: string;
  score: number | null;
  text: string | null;
}

/** История ответа на один пункт по замерам методики — старые первыми */
export function itemHistory(details: readonly ResponseDetail[], questionId: string): ItemAnswer[] {
  return [...details]
    .filter((d) => d.submittedAt)
    .sort((a, b) => Date.parse(a.submittedAt!) - Date.parse(b.submittedAt!))
    .map((d) => {
      const got = picked(d.answers.find((a) => a.questionId === questionId));
      return { responseId: d.id, at: d.submittedAt!, score: got.score, text: got.text };
    });
}

/** Наибольший вес варианта пункта — «1 бал з 3» */
export function itemMax(detail: ResponseDetail | null | undefined, questionId: string): number | null {
  const q = detail?.answers.find((a) => a.questionId === questionId);
  if (!q) return null;
  const scores = q.options.map((o) => o.score).filter((s): s is number => s !== null);
  return scores.length ? Math.max(...scores) : null;
}

/* ─────────── приёмы, неявки, назначения ─────────── */

/** Строка хронологии так, как её отдаёт сервер (у приёма kind = «visit») */
export interface TimelineRow {
  id: string;
  kind: string;
  at: string;
  title: string;
  detail?: string | null;
  severity?: string | null;
  href?: string | null;
  dueAt?: string | null;
}

export interface Visit {
  /** Идентификатор приёма (без «visit:») */
  id: string;
  at: string;
  status: string;
  specialist: string;
}

const PLANNED = new Set(["booked", "confirmed"]);
const HELD = new Set(["done", "arrived", "in_progress"]);

export function visitsOf(items: readonly TimelineRow[]): Visit[] {
  return items
    .filter((i) => i.kind === "visit")
    .map((i) => ({ id: i.id.replace(/^visit:/, ""), at: i.at, status: i.detail ?? "", specialist: i.title }))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Ближайший запланированный приём после «сейчас» */
export function nextVisit(visits: readonly Visit[], now: number): Visit | null {
  return visits.find((v) => PLANNED.has(v.status) && Date.parse(v.at) >= now) ?? null;
}

/** Последний проведённый приём до «сейчас» и его порядковый номер среди проведённых */
export function lastSession(visits: readonly Visit[], now: number): { visit: Visit; n: number } | null {
  const held = visits.filter((v) => HELD.has(v.status) && Date.parse(v.at) <= now);
  const visit = held[held.length - 1];
  return visit ? { visit, n: held.length } : null;
}

/** Проведённых приёмов всего — счётчик вкладки «Прийоми» считает все, кроме отменённых */
export function heldCount(visits: readonly Visit[]): number {
  return visits.filter((v) => HELD.has(v.status)).length;
}

/**
 * Свежая неявка: после последнего проведённого приёма и не старше `days`.
 * Неявка, за которой человек уже пришёл, — история, а не открытое дело.
 */
export function openNoShow(visits: readonly Visit[], now: number, days = 30): Visit | null {
  const last = lastSession(visits, now);
  const after = last ? Date.parse(last.visit.at) : -Infinity;
  const fresh = visits.filter(
    (v) => v.status === "no_show" && Date.parse(v.at) > after && now - Date.parse(v.at) <= days * 86_400_000,
  );
  return fresh[fresh.length - 1] ?? null;
}

export interface Assignment {
  id: string;
  title: string;
  at: string;
  dueAt: string | null;
}

/** Открытые назначения наборов — те, что человек ещё не прошёл и их не сняли */
export function openAssignments(items: readonly TimelineRow[]): Assignment[] {
  return items
    .filter((i) => i.kind === "assignment" && i.detail === "open")
    .map((i) => ({ id: i.id.replace(/^assignment:/, ""), title: i.title, at: i.at, dueAt: i.dueAt ?? null }))
    .sort((a, b) => Date.parse(a.dueAt ?? a.at) - Date.parse(b.dueAt ?? b.at));
}

/**
 * События «после сессии»: всё, что случилось после последнего проведённого
 * приёма (или за последние `days`, если приёмов не было), свежие последними.
 * Сам приём и запланированные после «сейчас» сюда не входят.
 */
export function sinceEvents(items: readonly TimelineRow[], since: number | null, now: number, days = 30): TimelineRow[] {
  const from = since ?? now - days * 86_400_000;
  return items
    .filter((i) => {
      const t = Date.parse(i.at);
      if (!Number.isFinite(t) || t <= from || t > now) return false;
      if (i.kind === "visit" && PLANNED.has(i.detail ?? "")) return false;
      return true;
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/* ─────────── человек ─────────── */

/** Полных лет на сегодня по дате рождения «ГГГГ-ММ-ДД»; null — даты нет */
export function ageOf(birthDate: string | null | undefined, now: number): number | null {
  const m = birthDate ? /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate) : null;
  if (!m) return null;
  const today = new Date(now);
  let age = today.getFullYear() - Number(m[1]);
  const before = today.getMonth() + 1 < Number(m[2]) || (today.getMonth() + 1 === Number(m[2]) && today.getDate() < Number(m[3]));
  if (before) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}
