import {
  CLINICAL_DOMAINS,
  instrumentCode,
  type AlertCase,
  type ClinicalDomain,
  type DynamicsPoint,
  type Incomparable,
  type PatientCardDomain,
  type RespondentDynamics,
  type ResponseDetail,
  type RiskSeverity,
  type ScaleDynamics,
  type Severity,
} from "@quizzy/shared";
import { betterOf, changeVerdict, reliableThreshold, type Better, type ChangeVerdict } from "../../charts/courseModel";
import { sortRungs } from "../../charts/ladder";
import { shownLimit, shownStep } from "../patients/model";

/*
 * Клиническая часть рабочего места пациента — чистые функции без React и
 * сети.
 *
 * Здесь решается, что встанет в «Клінічну картину» (строки по доменам,
 * сдвиг словом), что подняло открытый случай (сигналы, сложенные по пункту),
 * что в таблице пунктов, какой приём «следующий» и какая неявка «свежая».
 * Всё — из ответов приложения: динамика (GET /api/dynamics/respondents/:id),
 * домены шкал карточки (GET /api/patients/:id/card), прохождения
 * (GET /api/responses/:id), случаи и хронология (GET /api/timeline/:id).
 * Проверяется без отрисовки: apps/web/test/patientCardClinical.test.ts.
 */

/* ─────────── клиническая картина ─────────── */

/**
 * Строка «Клінічної картини»: одна методика в одном домене — последний балл,
 * полоса словом и сдвиг от первого замера, сказанный словом.
 *
 * Сдвиг судится тем же правилом, что курс на графике и «Динаміка»
 * (changeVerdict: |Δ| против MDC95 = 1,96·√2·SEM, то есть |RCI| > 1,96), но
 * на экран идёт не «RCI 2,28», а «значуще погіршення».
 */
export interface PictureRow {
  /** surveyId:домен — у DASS-42 одна методика даёт три строки в трёх доменах */
  key: string;
  domain: ClinicalDomain;
  surveyId: string;
  surveyTitle: string;
  /** Короткое имя методики: «PHQ-9» */
  code: string;
  /** Что меряет шкала строки: «Вираженість депресії» */
  scaleTitle: string;
  /** Сколько ещё шкал этой методики в этом домене свёрнуто в строку (самая тяжёлая — на виду) */
  folded: number;
  scale: ScaleDynamics;
  /** Замеры по времени, старые первыми */
  points: DynamicsPoint[];
  first: DynamicsPoint;
  last: DynamicsPoint;
  /**
   * Слово сдвига: «single» — замер один; «incomparable» — концы сравнивать
   * нельзя (другая версия, единицы, недостоверный протокол); прочее — как в
   * changeVerdict.
   */
  verdict: ChangeVerdict | "single" | "incomparable";
  /** Сдвиг первый → последний в единицах экрана (у доли — в. п.); null — не считается */
  delta: number | null;
  /** Порог значущої зміни в единицах экрана; null — похибку не из чего оценить */
  threshold: number | null;
  better: Better | null;
  incomparable: Incomparable | null;
  /** По этой методике поднят открытый сигнал риска */
  signal: boolean;
  /** Последний протокол недостоверен по шкалам достоверности */
  unreliable: boolean;
}

export interface PictureGroup {
  domain: ClinicalDomain;
  rows: PictureRow[];
  /** Есть открытый сигнал по методике этого домена */
  signal: boolean;
}

/**
 * Строка картины по одной шкале: последний замер, полоса и сдвиг от первого
 * замера словом. Её же берёт «Динаміка» — для таблицы шкал методики.
 */
export function scaleRow(
  sv: Pick<RespondentDynamics["surveys"][number], "surveyId" | "title" | "shortName">,
  scale: ScaleDynamics,
  domain: ClinicalDomain,
  signalResponses: ReadonlySet<string> = new Set(),
): PictureRow {
  const points = [...scale.points].sort(byTime);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const rungs = sortRungs((scale.bands ?? []).map((b) => ({ min: b.min, max: b.max, label: b.label, severity: b.severity })));
  const better = rungs.length ? betterOf(rungs) : null;
  const incomparable = scale.incomparable ?? null;
  const rc = reliableThreshold(scale);
  const raw = last.rawScore - first.rawScore;
  const single = points.length < 2;
  return {
    key: `${sv.surveyId}:${domain}`,
    domain,
    surveyId: sv.surveyId,
    surveyTitle: sv.title,
    /* короткое имя — от сервера (по ключу каталога), у старого ответа — из названия */
    code: sv.shortName ?? instrumentCode(sv.title),
    scaleTitle: scale.title,
    folded: 0,
    scale,
    points,
    first,
    last,
    verdict: single ? "single" : incomparable ? "incomparable" : changeVerdict(raw, rc, better),
    delta: single || incomparable ? null : shownStep(raw, last.normalization),
    threshold: rc === null ? null : shownLimit(rc, last.normalization),
    better,
    incomparable,
    signal: points.some((p) => signalResponses.has(p.responseId)),
    unreliable: last.reliable === false,
  };
}

const SEV_RANK: Record<Severity, number> = { none: 0, mild: 1, moderate: 2, severe: 3 };

/** Ступень тяжести числом; без полосы — ниже «норми» */
export function sevRank(s: Severity | null | undefined): number {
  return s ? SEV_RANK[s] : -1;
}

const byTime = (a: DynamicsPoint, b: DynamicsPoint) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt);

/**
 * Клиническая картина человека: строки по доменам, тяжёлое и рисковое —
 * первым.
 *
 * Домен шкалы приходит с сервера (карточка, `domains`): решает его ключ
 * каталога и код шкалы, а не название. Шкалы достоверности («L», «F») в
 * картину не идут — они о бланке. Несколько шкал одной методики в одном
 * домене (профиль Міні-мульта, «Адаптивність-200») — одна строка: самая
 * тяжёлая шкала на виду, остальные — в «Динаміці».
 *
 * Порядок: строки с открытым сигналом, потом по тяжести последнего замера,
 * потом свежие; домены — так же по своей худшей строке, при равенстве — в
 * клиническом порядке CLINICAL_DOMAINS (суицидальный риск первым).
 */
export function clinicalPicture(
  dynamics: RespondentDynamics | null | undefined,
  domains: readonly PatientCardDomain[] | null | undefined,
  /** Прохождения, поднявшие открытый сигнал риска (сигналы открытых случаев) */
  signalResponses: ReadonlySet<string> = new Set(),
): PictureGroup[] {
  if (!dynamics) return [];
  const domainOf = new Map((domains ?? []).map((d) => [`${d.surveyId}|${d.code}`, d.domain]));
  const rows: PictureRow[] = [];
  for (const sv of dynamics.surveys) {
    const clinical = sv.scales.filter((sc) => sc.points.length > 0 && (sc.kind ?? "clinical") === "clinical");
    const byDomain = new Map<ClinicalDomain, ScaleDynamics[]>();
    for (const sc of clinical) {
      const d = domainOf.get(`${sv.surveyId}|${sc.code}`) ?? "other";
      byDomain.set(d, [...(byDomain.get(d) ?? []), sc]);
    }
    for (const [domain, scales] of byDomain) {
      const lastOf = (sc: ScaleDynamics) => [...sc.points].sort(byTime).at(-1)!;
      const scale = scales.reduce((best, sc) => (sevRank(lastOf(sc).severity) > sevRank(lastOf(best).severity) ? sc : best));
      rows.push({ ...scaleRow(sv, scale, domain, signalResponses), folded: scales.length - 1 });
    }
  }
  const rowOrder = (a: PictureRow, b: PictureRow) =>
    Number(b.signal) - Number(a.signal) ||
    sevRank(b.last.severity) - sevRank(a.last.severity) ||
    Date.parse(b.last.submittedAt) - Date.parse(a.last.submittedAt);
  const groups = new Map<ClinicalDomain, PictureRow[]>();
  for (const r of rows) groups.set(r.domain, [...(groups.get(r.domain) ?? []), r]);
  return [...groups.entries()]
    .map(([domain, list]) => {
      const sorted = list.sort(rowOrder);
      return { domain, rows: sorted, signal: sorted.some((r) => r.signal) };
    })
    .sort(
      (a, b) =>
        Number(b.signal) - Number(a.signal) ||
        sevRank(b.rows[0]!.last.severity) - sevRank(a.rows[0]!.last.severity) ||
        CLINICAL_DOMAINS.indexOf(a.domain) - CLINICAL_DOMAINS.indexOf(b.domain),
    );
}

/* ─────────── сигналы случая ─────────── */

/** Сигналы случая, сложенные по пункту или шкале: «PHQ-9: думки про смерть — 5 разів» */
export interface SignalGroup {
  key: string;
  /** Подпись самого тяжёлого (при равенстве — свежего) сигнала группы */
  label: string;
  count: number;
  severity: RiskSeverity;
  /** Сигнал по ответу на пункт, а не по полосе шкалы */
  item: boolean;
  lastAt: string;
}

const RISK_RANK: Record<string, number> = { moderate: 1, severe: 2 };

/**
 * Что подняло открытые случаи — по пункту или шкале, а не строкой на сигнал.
 *
 * Прежде «Огляд» открывался восемью строками «Сигнал: …» — один и тот же
 * пункт PHQ-9 в каждом из повторных замеров, все в одну минуту. Здесь пункт
 * (или шкала) — одна строка со счётом; первыми — тяжёлые, при равенстве —
 * ответ на пункт (он конкретнее полосы), потом частые.
 */
export function signalGroups(cases: readonly AlertCase[]): SignalGroup[] {
  const groups = new Map<string, SignalGroup>();
  for (const c of cases) {
    for (const s of c.signals) {
      const key = `${s.kind}|${s.questionId ?? s.questionTitle}`;
      const g = groups.get(key);
      if (!g) {
        groups.set(key, { key, label: s.label, count: 1, severity: s.severity, item: s.kind === "option", lastAt: s.at });
        continue;
      }
      g.count += 1;
      const heavier = (RISK_RANK[s.severity] ?? 0) - (RISK_RANK[g.severity] ?? 0);
      if (heavier > 0 || (heavier === 0 && Date.parse(s.at) > Date.parse(g.lastAt))) {
        g.label = s.label;
        g.severity = s.severity;
      }
      if (Date.parse(s.at) > Date.parse(g.lastAt)) g.lastAt = s.at;
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      (RISK_RANK[b.severity] ?? 0) - (RISK_RANK[a.severity] ?? 0) ||
      Number(b.item) - Number(a.item) ||
      b.count - a.count ||
      Date.parse(b.lastAt) - Date.parse(a.lastAt),
  );
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
