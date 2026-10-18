import {
  TOO_FAST_MS,
  comparability,
  itemContribution,
  itemMaxContribution,
  quantile,
  rciForDisplay,
  type Answer,
  type Incomparable,
  type RespondentDynamics,
  type ResponseDetail,
  type ResponseDetailAnswer,
  type ResponseDetailScore,
  type ScaleNormalization,
  type Severity,
  type SurveyFull,
} from "@quizzy/shared";
import { betterOf, changeVerdict, reliableThreshold, type Better, type ChangeVerdict } from "../../charts/courseModel";
import { num, sortRungs, type Rung } from "../../charts/ladder";

/*
 * Модель экранов прохождения: протокол (сетка или список ответов),
 * результат по шкалам, динамика, вклад пунктов, время ответов.
 *
 * Всё — из ответа GET /api/responses/:id той версии, которую проходили:
 * сервер отдаёт персоналу вес каждого варианта и всю лестницу полос той же
 * версии (ResponseDetailScore.bands). Прежняя модель досчитывала веса и
 * лестницу из ДЕЙСТВУЮЩЕЙ методики и прятала их, если версия сменилась;
 * с тех пор как прохождение несёт их само, второй источник не нужен, а с
 * ним ушёл и случай «правдоподобные, но чужие числа».
 *
 * Где граница с пациентом. Тот же маршрут открыт самому обследуемому, и ему
 * веса не отдаются (#141), — но эти экраны консольные, для role === "user"
 * они не рендерятся вовсе (App.tsx, ветка кабинета).
 *
 * Функции чистые и вынесены из разметки ради проверки.
 */

export interface OptionRow {
  id: string;
  text: string;
  chosen: boolean;
  /** Вес варианта; null — сервер не дал (обследуемому) */
  score: number | null;
  riskFlag: boolean;
}

export interface QuestionView {
  questionId: string;
  number: number;
  title: string;
  answered: boolean;
  /** Варианты столбиком; пусто у пункта без вариантов и у порядка */
  options: OptionRow[];
  /** Ответ строкой: текст, число, дата, цепочка порядка, ячейки матрицы */
  free: string | null;
  score: number | null;
}

function freeAnswer(a: ResponseDetailAnswer, textById: Map<string, string>): string | null {
  if (a.text) return a.text;
  if (a.number !== null) return String(a.number);
  if (a.date) return a.date;
  if (a.ranking?.length) return a.ranking.map((id) => textById.get(id) ?? id).join(" → ");
  return null;
}

/**
 * Протокол списком: пункт и его варианты столбиком, выбранный отмечен.
 *
 * Порядок (ranking) — цепочкой «А → Б → В», а не столбиком вариантов с
 * весами: вес у варианта порядка не значит ничего. Матрица — строками
 * «строка: выбранный столбец». Номер — сквозной по позиции, как в сетке.
 */
export function answerList(detail: ResponseDetail): QuestionView[] {
  return [...detail.answers]
    .sort((a, b) => a.position - b.position)
    .map((a, i) => {
      const picked = new Set([...(a.optionIds ?? []), ...Object.values(a.matrix ?? {})]);
      const rowIds = new Set(Object.keys(a.matrix ?? {}));
      const textById = new Map(a.options.map((o) => [o.id, o.text] as const));
      const chain = a.type === "ranking";
      const matrix = !!a.matrix && Object.keys(a.matrix).length > 0;
      const options: OptionRow[] =
        chain || matrix
          ? []
          : a.options
              .filter((o) => !rowIds.has(o.id))
              .map((o) => ({ id: o.id, text: o.text, chosen: picked.has(o.id), score: o.score, riskFlag: o.riskFlag }));
      const free = options.length
        ? null
        : matrix
          ? Object.entries(a.matrix!)
              .map(([row, opt]) => `${textById.get(row) ?? row}: ${textById.get(opt) ?? opt}`)
              .join("; ")
          : freeAnswer(a, textById);
      return { questionId: a.questionId, number: i + 1, title: a.title, answered: a.answered, options, free, score: a.score };
    });
}

export interface BandText {
  label: string;
  severity: Severity;
  description: string | null;
  recommendation: string | null;
}

export interface ResultRow {
  scaleId: string;
  code: string;
  title: string;
  value: number;
  normalization: ScaleNormalization;
  /** Нормирование удалось: значение в тех же единицах, в каких заданы ступени */
  normalized: boolean;
  /** Ступени той версии, которую проходили; пусто — полос нет или значение не нормировано */
  rungs: Rung[];
  /**
   * Верх метра для шкалы без ступеней. null — метр не рисуется: у T-балла
   * верха нет, и «0…64» с маркером у правого края читалось бы как «максимум».
   */
  meterMax: number | null;
  /** «12 з 27», «T-бал 64», «стен 7» */
  valueText: string;
  band: BandText | null;
  /** У шкалы полос нет вовсе: интерпретировать не по чему (а не «не попал») */
  noBands: boolean;
  /** Полосы есть, значение нормировано, но ни в одну не легло — вышло за лестницу */
  outside: boolean;
}

export interface ResultLabels {
  /** «з» в «12 з 27» */
  of: string;
  /** Подписи единиц: norm.raw, norm.tscore, … */
  norm: Record<ScaleNormalization, string>;
}

/**
 * Нормировано ли значение.
 *
 * Поля нет у ответа сервера, собранного до того, как маршрут начал его
 * отдавать, — такое значение считается нормированным: так его и показывал
 * экран всё это время, а при ненормированном сервер не нашёл бы полосы, и
 * лестница без попавшей ступени это покажет сама.
 */
function isNormalized(sc: ResponseDetailScore): boolean {
  return sc.normalized !== false;
}

function valueTextOf(sc: ResponseDetailScore, labels: ResultLabels): string {
  /*
   * Сырой балл — «из скольких»: «12» без максимума не говорит ничего, а
   * «12 з 27» — уже почти интерпретация. Нормированные единицы подписаны
   * своим словом: у T-балла и стена «из скольких» нет.
   */
  if (!isNormalized(sc) || sc.normalization === "raw") {
    return sc.maxScore > 0 ? `${num(sc.value)} ${labels.of} ${num(sc.maxScore)}` : num(sc.value);
  }
  return `${labels.norm[sc.normalization]} ${num(sc.value)}`;
}

function meterMaxOf(sc: ResponseDetailScore): number | null {
  if (!isNormalized(sc) || sc.normalization === "raw") return sc.maxScore > 0 ? sc.maxScore : null;
  if (sc.normalization === "ratio") return 1;
  if (sc.normalization === "sten") return 10;
  return null;
}

/**
 * Результат по шкалам: лестница той версии, попавшая полоса и подпись
 * значения.
 *
 * Ненормированное значение (нет нормы для пола и возраста) — сырой балл, а
 * ступени заданы в T-баллах или стенах. Лестница для него не рисуется
 * вовсе, а не рисуется «как получится»: сырой 12 на лестнице T-баллов лёг
 * бы в «низький», и это была бы неправда, нарисованная аккуратно. Вместо
 * неё — метр 0…максимум в сырых баллах и честная пометка.
 */
export function resultRows(detail: ResponseDetail, labels: ResultLabels): ResultRow[] {
  return detail.scores.map((sc) => {
    const normalized = isNormalized(sc);
    const hit = normalized ? sc.bands.find((b) => b.hit) : undefined;
    const band: BandText | null = hit
      ? { label: hit.label, severity: hit.severity, description: hit.description, recommendation: hit.recommendation }
      : normalized && sc.band
        ? {
            label: sc.band.label,
            severity: sc.band.severity,
            description: sc.band.description,
            recommendation: sc.band.recommendation,
          }
        : null;
    const rungs = normalized ? rungsOf(sc) : [];
    return {
      scaleId: sc.scaleId,
      code: sc.scaleCode,
      title: sc.scaleTitle,
      value: sc.value,
      normalization: sc.normalization,
      normalized,
      rungs,
      meterMax: rungs.length ? null : meterMaxOf(sc),
      valueText: valueTextOf(sc, labels),
      band,
      noBands: normalized && sc.bands.length === 0 && !sc.band,
      outside: normalized && rungs.length > 0 && !band,
    };
  });
}

function rungsOf(sc: ResponseDetailScore): Rung[] {
  return sortRungs(sc.bands.map((b) => ({ min: b.minScore, max: b.maxScore, label: b.label, severity: b.severity })));
}

/* ─────────── динамика ─────────── */

/**
 * Вердикт о сдвиге от предыдущего замера.
 *
 *   reliable — |RCI| > 1,96: больше ошибки измерения;
 *   within   — в пределах ошибки;
 *   noSem    — ошибка измерения неизвестна: мала выборка или не посчитана альфа;
 *   versions — замеры сделаны на разных версиях методики, баллы несравнимы.
 */
export type ShiftVerdict = "reliable" | "within" | "noSem" | "versions" | "units" | "unreliable";

export interface Shift {
  /** Этот замер минус предыдущий, в единицах полос */
  delta: number;
  /** Когда был предыдущий */
  prevAt: string;
  from: { label: string; severity: Severity } | null;
  to: { label: string; severity: Severity } | null;
  verdict: ShiftVerdict;
  /** Индекс достоверности; null, когда считать не из чего */
  rci: number | null;
}

export interface TrendPointView {
  responseId: string;
  at: string;
  value: number;
  band: { label: string; severity: Severity } | null;
  /** Замер этого экрана */
  focus: boolean;
  versionNo: number | null;
  /**
   * Единицы и достоверность замера (DynamicsPoint): без них сырой балл без
   * норм вычитался из T-балла той же версии, и экран писал «більше за
   * похибку» там, где изменились единицы. Нет поля — считается «да».
   */
  normalized?: boolean;
  normalization?: ScaleNormalization;
  reliable?: boolean;
}

export interface TrendScale {
  code: string;
  title: string;
  /** Лестница той версии, которую проходили в ЭТОТ раз: по ней и читается, куда пришёл балл */
  rungs: Rung[];
  /** Ошибка одного измерения в единицах полос; null — неизвестна */
  sem: number | null;
  points: TrendPointView[];
  /** Сдвиг от предыдущего замера; null — это прохождение первое или его нет в ряду */
  shift: Shift | null;
  /** Это прохождение — первое в ряду шкалы */
  first: boolean;
  /** В ряду замеры разных версий методики: пороги нарисованы по версии этого прохождения */
  mixedVersions: boolean;
}

export type TrendsView =
  /** Замер у человека по этой методике один — сравнивать не с чем */
  | { kind: "single" }
  | {
      kind: "series";
      scales: TrendScale[];
      /**
       * Есть ли это прохождение в ряду. Нет — когда оно не завершено: в
       * динамику идут только сданные, и график показывает остальные без
       * отметки «це проходження».
       */
      focusInSeries: boolean;
    };

/** Критерий Jacobson–Truax: |RCI| больше 1,96 — сдвиг больше ошибки измерения (p < 0,05) */
export const RCI_CRITERION = 1.96;

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Сдвиг этого замера от предыдущего и можно ли ему верить.
 *
 * От ПРЕДЫДУЩЕГО, а не от первого, как считает сервер (reliableChange в
 * ScaleDynamics — первый↔последний): на экране одного прохождения вопрос
 * «что изменилось с прошлого раза», а не «что за всё лечение». Ошибка
 * измерения при этом та же — она свойство шкалы, а не пары замеров, — и
 * RCI = Δ / (√2·SEM) (packages/shared/src/rci.ts: Sdiff = √2·SEM).
 *
 * Сравнимы ли два замера — то же правило, что у сервера (comparability в
 * shared/rci.ts): разные версии — «versions» (приведение сервер считает
 * только к последней версии, а здесь пара соседних); нормированный против
 * сырого — «units», и разность таких чисел не показывается вовсе;
 * недостоверный протокол — «unreliable». Неизвестная версия у обоих замеров
 * (прохождения до версионирования) считается одной и той же: так их всё это
 * время и сравнивали.
 *
 * RCI для показа — rciForDisplay: вердикт решает точное число, и показанное
 * не должно перескакивать через критерий (1,964 не становится 1,96).
 */
export function shiftOf(prev: TrendPointView, cur: TrendPointView, sem: number | null): Shift {
  const delta = round2(cur.value - prev.value);
  const base = { delta, prevAt: prev.at, from: prev.band, to: cur.band };
  const why = comparability(markOf(prev), markOf(cur));
  if (why === "version") return { ...base, verdict: "versions", rci: null };
  if (why === "units") return { ...base, verdict: "units", rci: null };
  if (why === "unreliable") return { ...base, verdict: "unreliable", rci: null };
  if (!(sem !== null && Number.isFinite(sem) && sem > 0)) return { ...base, verdict: "noSem", rci: null };
  const rci = delta / (Math.SQRT2 * sem);
  return { ...base, verdict: Math.abs(rci) > RCI_CRITERION ? "reliable" : "within", rci: rciForDisplay(rci) };
}

const markOf = (p: TrendPointView) => ({
  version: p.versionNo ?? null,
  normalized: p.normalized,
  normalization: p.normalization ?? null,
  reliable: p.reliable,
});

/**
 * Ряды по шкалам этого прохождения из динамики человека.
 *
 * Шкалы сопоставляются по коду: id шкалы меняется с каждой версией
 * методики, код — нет (так же группирует и сервер). Значение точки —
 * DynamicsPoint.rawScore, и, несмотря на имя, это score.value, то есть
 * значение в единицах полос (routes/dynamics.ts); SEM — в тех же единицах.
 */
export function buildTrends(detail: ResponseDetail, dyn: RespondentDynamics): TrendsView {
  const entry = dyn.surveys.find((s) => s.surveyId === detail.survey.id);
  if (!entry || entry.responseCount <= 1) return { kind: "single" };

  const scales: TrendScale[] = [];
  for (const sc of detail.scores) {
    const series = entry.scales.find((s) => s.code === sc.scaleCode);
    if (!series || !series.points.length) continue;
    const points: TrendPointView[] = [...series.points]
      .filter((p) => Number.isFinite(p.rawScore))
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
      .map((p) => ({
        responseId: p.responseId,
        at: p.submittedAt,
        value: p.rawScore,
        band: p.bandLabel && p.severity ? { label: p.bandLabel, severity: p.severity } : null,
        focus: p.responseId === detail.id,
        versionNo: p.versionNo ?? null,
        normalized: p.normalized,
        normalization: p.normalization,
        reliable: p.reliable,
      }));
    if (!points.length) continue;
    const i = points.findIndex((p) => p.focus);
    const sem = series.sem != null && Number.isFinite(series.sem) && series.sem > 0 ? series.sem : null;
    /*
     * SEM сервер считает в единицах ПОСЛЕДНЕГО замера ряда (версия и
     * нормировка последнего). К паре из другой версии или других единиц она
     * не относится: ошибка измерения — свойство шкалы в этих единицах.
     */
    const lastPoint = points[points.length - 1]!;
    const semFor = (p: TrendPointView) => (comparability(markOf(p), markOf(lastPoint)) === null ? sem : null);
    scales.push({
      code: sc.scaleCode,
      title: sc.scaleTitle,
      rungs: rungsOf(sc),
      sem,
      points,
      shift: i > 0 ? shiftOf(points[i - 1]!, points[i]!, semFor(points[i]!)) : null,
      first: i === 0,
      mixedVersions: new Set(points.map((p) => p.versionNo)).size > 1,
    });
  }

  if (!scales.some((s) => s.points.length > 1)) return { kind: "single" };
  return { kind: "series", scales, focusInSeries: scales.some((s) => s.points.some((p) => p.focus)) };
}

/* ─────────── вклад пунктов ─────────── */

export interface ContributionItem {
  questionId: string;
  /** Сквозной номер пункта, как «Питання №N» на вкладке «Відповіді» */
  number: number;
  title: string;
  /** Сколько пункт дал шкале — функцией движка, с обратным ключом и весом */
  value: number;
  /** Сколько мог дать */
  max: number;
  /** Выбран вариант, помеченный как критический */
  critical: boolean;
  /**
   * Вклад того же пункта в прежней попытке той же версии — отметка «було»
   * на полосе; null — сравнивать не с чем (первая попытка, другая версия,
   * пункт тогда пропущен).
   */
  prev: number | null;
}

export interface ScaleContribution {
  scaleId: string;
  title: string;
  /** Отвеченные пункты с числовым вкладом (и нулевым), от большего к меньшему */
  items: ContributionItem[];
  /** Пунктов шкалы без ответа: пропущены или не показаны ветвлением */
  unanswered: number;
  /** Пунктов в ключе шкалы всего */
  size: number;
  /** Верх полос: наибольшее, что мог дать пункт этой шкалы */
  top: number;
}

export interface ContributionsView {
  /**
   * Методика пришла не той версии, что проходили: номер или идентификаторы
   * не совпали. Вклад тогда не считается вовсе — ключ чужой версии даёт
   * правдоподобные, но чужие числа.
   */
  stale: boolean;
  scales: ScaleContribution[];
}

/** Ответ прохождения в том виде, в каком его читает движок подсчёта */
function engineAnswer(a: ResponseDetailAnswer): Answer {
  return {
    questionId: a.questionId,
    optionIds: a.optionIds ?? undefined,
    number: a.number ?? undefined,
    matrix: a.matrix ?? undefined,
    ranking: a.ranking ?? undefined,
    skipped: !a.answered,
  };
}

/** Номера пунктов по позиции — те же, что «Питання №N» на вкладке ответов */
function numbering(detail: ResponseDetail): Map<string, number> {
  return new Map(
    [...detail.answers].sort((a, b) => a.position - b.position).map((a, i) => [a.questionId, i + 1] as const),
  );
}

/**
 * Какие ответы дали балл.
 *
 * Вклад считает itemContribution — та же функция, которой сервер считал
 * балл, — по ключу ТОЙ версии методики, которую проходили. Собственный счёт
 * здесь («вес выбранного варианта») разошёлся бы с движком на первом же
 * пункте с обратным ключом, режимом «совпал с ключом» (Міні-мульт) или
 * матрицей, где вклад — сумма по строкам.
 *
 * Пункт без балла (текст, дата, порядок) в перечень не попадает и
 * пропущенным не считается: он ответ, просто не числовой. Нулевой вклад
 * попадает (Polypsy 2.0): «сповільненість — 0» тоже ответ на вопрос, из
 * чего сложилась сумма, а пустая полоса рядом с полными это и показывает.
 *
 * `prev` — прежняя попытка той же версии: её вклад по тому же пункту ложится
 * отметкой на полосу. Другая версия — отметок нет: ключ мог смениться.
 */
export function buildContributions(
  detail: ResponseDetail,
  survey: SurveyFull,
  prev: ResponseDetail | null = null,
): ContributionsView {
  const questionById = new Map(survey.questions.map((q) => [q.id, q] as const));
  const scaleById = new Map(survey.scales.map((s) => [s.id, s] as const));
  const stale =
    survey.versionNumber !== detail.survey.versionNumber ||
    detail.scores.some((sc) => !scaleById.has(sc.scaleId)) ||
    detail.answers.some((a) => !questionById.has(a.questionId));
  if (stale) return { stale: true, scales: [] };

  const answerById = new Map(detail.answers.map((a) => [a.questionId, a] as const));
  const prevById =
    prev && prev.survey.versionNumber === detail.survey.versionNumber
      ? new Map(prev.answers.map((a) => [a.questionId, a] as const))
      : null;
  const numberOf = numbering(detail);

  const scales = detail.scores.map((sc): ScaleContribution => {
    const scale = scaleById.get(sc.scaleId)!;
    const items: ContributionItem[] = [];
    let unanswered = 0;
    let top = 0;
    for (const item of scale.items) {
      const question = questionById.get(item.questionId);
      if (!question) continue;
      const max = itemMaxContribution(question, item);
      top = Math.max(top, max);
      const a = answerById.get(item.questionId);
      if (!a || !a.answered) {
        unanswered++;
        continue;
      }
      const value = itemContribution(question, item, engineAnswer(a));
      if (value === null || !Number.isFinite(value)) continue;
      const picked = new Set([...(a.optionIds ?? []), ...Object.values(a.matrix ?? {})]);
      const before = prevById?.get(item.questionId);
      const was = before?.answered ? itemContribution(question, item, engineAnswer(before)) : null;
      items.push({
        questionId: a.questionId,
        number: numberOf.get(a.questionId) ?? 0,
        title: a.title,
        value: round2(value),
        max: round2(max),
        critical: a.options.some((o) => o.riskFlag && picked.has(o.id)),
        prev: was === null || !Number.isFinite(was) ? null : round2(was),
      });
    }
    items.sort((x, y) => y.value - x.value || x.number - y.number);
    /*
     * Верх полос — наибольшее, что мог дать пункт шкалы, а не наибольший
     * фактический вклад: «2 з 3» и «3 з 3» должны отличаться длиной, а при
     * верхе по данным самый большой вклад всегда рисовался бы полной
     * полосой, будь он хоть единицей из трёх.
     */
    return {
      scaleId: sc.scaleId,
      title: sc.scaleTitle,
      items,
      unanswered,
      size: scale.items.length,
      top: Math.max(top, ...items.map((i) => i.value), 0),
    };
  });

  return { stale: false, scales };
}

/* ─────────── как отвечал ─────────── */

export interface ItemTiming {
  questionId: string;
  number: number;
  /** Время на пункте, мс; 0 — не замерено (бумажный ввод, старый клиент) */
  ms: number;
  answered: boolean;
  /** Отвечен быстрее порога */
  fast: boolean;
  /** Сколько раз менял ответ */
  changes: number;
}

export interface AnsweringView {
  /** Всё прохождение, мс; null — не замерено */
  totalMs: number | null;
  /** Медиана времени на отвеченный пункт; null — ни один пункт не замерен */
  medianMs: number | null;
  items: ItemTiming[];
  /** Хоть один пункт замерен: иначе столбцы рисовать не из чего */
  timed: boolean;
  thresholdMs: number;
  /** Номера слишком быстрых */
  fast: number[];
  /** Номера пунктов, где ответ меняли, и сколько раз */
  changed: { number: number; times: number }[];
  /** Сколько пунктов без ответа */
  unanswered: number;
}

/**
 * Как человек заполнял: время, быстрые ответы, смены ответа, пропуски.
 *
 * Быстрым считается только отвеченный пункт с замеренным временем меньше
 * порога — та же мерка, что у аналитики методики (qualityOf на сервере):
 * порог методики, а без него общий TOO_FAST_MS. Медиана, а не среднее: один
 * пункт, на котором человек отвлёкся на десять минут, сдвигает среднее
 * втрое и ничего не говорит о том, как он читал остальные.
 */
export function buildAnswering(detail: ResponseDetail, tooFastMs?: number | null): AnsweringView {
  const thresholdMs = tooFastMs && tooFastMs > 0 ? tooFastMs : TOO_FAST_MS;
  const items: ItemTiming[] = [...detail.answers]
    .sort((a, b) => a.position - b.position)
    .map((a, i) => {
      const ms = Number.isFinite(a.durationMs) && a.durationMs > 0 ? a.durationMs : 0;
      return {
        questionId: a.questionId,
        number: i + 1,
        ms,
        answered: a.answered,
        fast: a.answered && ms > 0 && ms < thresholdMs,
        changes: a.changeCount > 0 ? a.changeCount : 0,
      };
    });
  const timedMs = items.filter((i) => i.answered && i.ms > 0).map((i) => i.ms);
  return {
    totalMs: Number.isFinite(detail.durationMs) && detail.durationMs > 0 ? detail.durationMs : null,
    medianMs: quantile(timedMs, 0.5),
    items,
    timed: items.some((i) => i.ms > 0),
    thresholdMs,
    fast: items.filter((i) => i.fast).map((i) => i.number),
    changed: items.filter((i) => i.changes > 0).map((i) => ({ number: i.number, times: i.changes })),
    unanswered: items.filter((i) => !i.answered).length,
  };
}

/* ─────────── сетка ответов ─────────── */

export interface GridColumn {
  /** Текст варианта — одинаковый у всех пунктов сетки */
  text: string;
  /** Вес варианта, если он одинаков у всех пунктов; иначе null (у пунктов с обратным ключом разный) */
  score: number | null;
}

export interface GridRow {
  questionId: string;
  number: number;
  title: string;
  answered: boolean;
  /** Номер выбранного столбца; null — не отвечено */
  chosen: number | null;
  /** Балл за ответ (вес выбранного варианта) */
  score: number | null;
  /** Столбец, выбранный в прежней попытке той же версии; null — не с чем сравнить */
  prev: number | null;
  prevScore: number | null;
  /** Выбран критический вариант */
  critical: boolean;
  /** Пункт входит в ключ хотя бы одной шкалы; false — «не входить у суму» */
  inScale: boolean;
}

/** Пункт вне сетки: другой набор вариантов, текст, число, дата */
export interface ExtraRow {
  questionId: string;
  number: number;
  title: string;
  answered: boolean;
  answer: string | null;
  score: number | null;
  critical: boolean;
  inScale: boolean;
}

export interface AnswerGrid {
  columns: GridColumn[];
  rows: GridRow[];
  extra: ExtraRow[];
}

/** Наибольшее число вариантов, при котором сетка ещё читается на 1280 */
const GRID_MAX = 6;

/**
 * Сетка ответов: пункты строками, варианты столбцами — как бланк PHQ-9.
 *
 * Сетка возможна, когда большинство пунктов с одним выбором делит один и
 * тот же набор вариантов (по тексту и порядку): тогда столбец «Більше
 * половини днів» значит одно и то же в каждой строке. Пункты с другим
 * набором (десятый пункт PHQ-9), с текстом или числом — строками под
 * сеткой. Нет общего набора — сетки нет (null), экран показывает список.
 *
 * `prev` — ответы прежней попытки той же версии (пустая карта — не с чем
 * сравнить): кольцо на прежнем столбце и «від …» по баллу.
 */
export function answerGrid(
  detail: ResponseDetail,
  survey: Pick<SurveyFull, "scales" | "versionNumber"> | null,
  prev: ReadonlyMap<string, { optionIds: string[]; score: number | null; answered: boolean }>,
): AnswerGrid | null {
  const ordered = [...detail.answers].sort((a, b) => a.position - b.position);
  const own = (a: ResponseDetailAnswer) => {
    const rows = new Set(Object.keys(a.matrix ?? {}));
    return a.options.filter((o) => !rows.has(o.id));
  };
  const signature = (a: ResponseDetailAnswer) =>
    own(a)
      .map((o) => o.text.trim().toLowerCase())
      .join("\u0001");
  const single = ordered.filter((a) => (a.type === "single" || a.type === "yesno") && own(a).length >= 2);
  const counts = new Map<string, number>();
  for (const a of single) counts.set(signature(a), (counts.get(signature(a)) ?? 0) + 1);
  const [sig, n] = [...counts.entries()].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
  if (!sig || n < 2 || n * 2 < single.length) return null;
  const sample = single.find((a) => signature(a) === sig)!;
  if (own(sample).length > GRID_MAX) return null;

  const sameVersion = survey === null || survey.versionNumber === detail.survey.versionNumber;
  const scaled = new Set(survey && sameVersion ? survey.scales.flatMap((s) => s.items.map((i) => i.questionId)) : []);
  const inScale = (id: string) => survey === null || !sameVersion || scaled.has(id);

  const inGrid = new Set(single.filter((a) => signature(a) === sig).map((a) => a.questionId));
  const gridAnswers = ordered.filter((a) => inGrid.has(a.questionId));
  const columns: GridColumn[] = own(sample).map((o, k) => {
    const weights = new Set(gridAnswers.map((a) => own(a)[k]?.score ?? null));
    const only = weights.size === 1 ? [...weights][0]! : null;
    return { text: o.text, score: only };
  });

  const rows: GridRow[] = [];
  const extra: ExtraRow[] = [];
  ordered.forEach((a, i) => {
    const number = i + 1;
    const picked = new Set(a.optionIds ?? []);
    const critical = a.options.some((o) => o.riskFlag && picked.has(o.id));
    if (inGrid.has(a.questionId)) {
      const opts = own(a);
      const chosen = opts.findIndex((o) => picked.has(o.id));
      const was = prev.get(a.questionId);
      const wasAt = was?.answered ? opts.findIndex((o) => was.optionIds.includes(o.id)) : -1;
      rows.push({
        questionId: a.questionId,
        number,
        title: a.title,
        answered: a.answered && chosen >= 0,
        chosen: a.answered && chosen >= 0 ? chosen : null,
        score: a.score,
        prev: wasAt >= 0 ? wasAt : null,
        prevScore: was?.answered ? was.score : null,
        critical,
        inScale: inScale(a.questionId),
      });
      return;
    }
    const text = new Map(a.options.map((o) => [o.id, o.text] as const));
    const answer = !a.answered
      ? null
      : a.optionIds?.length
        ? a.optionIds.map((id) => text.get(id) ?? id).join(", ")
        : a.matrix
          ? Object.entries(a.matrix)
              .map(([row, opt]) => `${text.get(row) ?? row}: ${text.get(opt) ?? opt}`)
              .join("; ")
          : freeAnswer(a, text);
    extra.push({
      questionId: a.questionId,
      number,
      title: a.title,
      answered: a.answered,
      answer,
      score: a.score,
      critical,
      inScale: inScale(a.questionId),
    });
  });
  return { columns, rows, extra };
}

/* ─────────── сдвиг этого замера ─────────── */

export interface ShiftLine {
  delta: number;
  /** С каким замером сравнили */
  at: string;
  /** Вердикт по порогу надёжной зміни или почему пара несравнима */
  verdict: ChangeVerdict | Incomparable;
}

export interface ScaleChange {
  /** Порог надёжной зміни в баллах (MDC95); null — оценить нечем */
  rc: number | null;
  /** Стандартная ошибка измерения — «похибка ±» */
  sem: number | null;
  better: Better | null;
  fromPrev: ShiftLine | null;
  /** От первого замера — только когда он не совпадает с предыдущим */
  fromStart: ShiftLine | null;
}

/**
 * «−2 від 11.09, у межах похибки; −5 від 24.08, поріг надійної зміни 6».
 *
 * Порог — тот же, что у графика курса (reliableThreshold: MDC95 из основы
 * надёжной зміни или из SEM), вердикт — тот же changeVerdict, сравнимость —
 * то же правило comparability: экран прохождения и график курса не должны
 * называть один сдвиг по-разному. Это прохождение не в ряду (не завершено)
 * — null.
 */
export function scaleChange(
  detail: Pick<ResponseDetail, "id" | "survey">,
  dyn: RespondentDynamics | null,
  code: string,
  rungs: readonly Rung[],
): ScaleChange | null {
  const scale = dyn?.surveys.find((s) => s.surveyId === detail.survey.id)?.scales.find((s) => s.code === code);
  if (!scale) return null;
  const points = [...scale.points].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  const i = points.findIndex((p) => p.responseId === detail.id);
  if (i < 0) return null;
  const cur = points[i]!;
  const first = points[0]!;
  const rc = first.reliable === false ? null : reliableThreshold(scale);
  const better = betterOf(rungs);
  const mark = (p: (typeof points)[number]) => ({
    version: p.versionNo ?? null,
    normalized: p.normalized,
    normalization: p.normalization ?? null,
    reliable: p.reliable,
  });
  const line = (other: (typeof points)[number]): ShiftLine => {
    const delta = round2(cur.rawScore - other.rawScore);
    const why = comparability(mark(other), mark(cur));
    return { delta, at: other.submittedAt, verdict: why ?? changeVerdict(delta, rc, better) };
  };
  const sem = scale.sem != null && Number.isFinite(scale.sem) && scale.sem > 0 ? round2(scale.sem) : null;
  return {
    rc,
    sem,
    better,
    fromPrev: i > 0 ? line(points[i - 1]!) : null,
    fromStart: i > 1 ? line(first) : null,
  };
}
