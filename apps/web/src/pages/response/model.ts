import {
  TOO_FAST_MS,
  itemContribution,
  itemMaxContribution,
  quantile,
  type Answer,
  type RespondentDynamics,
  type ResponseDetail,
  type ResponseDetailAnswer,
  type ResponseDetailScore,
  type ScaleNormalization,
  type Severity,
  type SurveyFull,
} from "@quizzy/shared";
import { num, sortRungs, type Rung } from "../../charts/ladder";

/*
 * Модель экрана «пройденный тест»: что показать в строке варианта и в лестнице
 * диапазонов, собранное из двух ответов сервера.
 *
 * Почему из двух. GET /api/responses/:id отдаёт ответы и баллы по шкалам, но
 * намеренно срезает вес варианта (options.score) и не отдаёт соседние
 * полосы — только ту, в которую попал балл (apps/api/src/routes/responses.ts,
 * «Варианты пункта — вместе с ответом»). Срезает не по забывчивости: тот же
 * маршрут открыт самому обследуемому, а баллы за варианты пациент видеть не
 * должен. Кадр f34 рисует и вес каждого варианта, и все три ступени «від —
 * до», и подсвеченную ступень. Недостающее берётся из GET /api/surveys/:id:
 * там и веса, и полосы целиком.
 *
 * Где на самом деле граница с пациентом. GET /api/surveys/:id НЕ закрыт от
 * пациента — маршрут объявлен с access: "user" (apps/api/src/lib/openapi.ts),
 * getSurvey в routes/surveys.ts роли не проверяет, и options.score в ответе
 * получает любой вошедший. Веса не попадают пациенту на экран не потому, что
 * сервер их прячет, а потому, что консольные маршруты — и этот экран среди
 * них — для role === "user" не рендерятся вовсе (App.tsx, ветка кабинета).
 * Это важно назвать прямо: вывод «раз маршрут отдаёт веса, значит, их можно
 * показывать и в кабинете» неверен — в кабинете вес варианта подсказывает
 * ответ, и закрывать его надо на сервере (в ответе прохождения он уже срезан),
 * а не полагаться на то, что кабинет пока его не запрашивает.
 *
 * Чего это стоит и где проходит граница. Методика по этому адресу — ДЕЙСТВУЮЩЕЙ
 * версии, а человек мог проходить прежнюю: каждая правка методики создаёт
 * новую версию с новыми идентификаторами пунктов, вариантов и шкал. Совпасть
 * могут только идентификаторы одной версии, поэтому сопоставление идёт по
 * ним, и когда версия сменилась, вес варианта и лестница не подставляются
 * вовсе — вместо правдоподобных, но чужих чисел на экране прочерк и строка
 * «методику изменено». Это записано в риске сверки макета: «экран покажет
 * правдоподобные, но чужие баллы» — и здесь ровно тот случай, когда лучше
 * не показать, чем показать не то.
 *
 * Функции чистые и вынесены из разметки ради проверки: сценарий «версия
 * сменилась» в браузере воспроизводится только правкой методики на живой
 * базе, а здесь — двумя объектами.
 */

export interface OptionRow {
  id: string;
  text: string;
  chosen: boolean;
  /** Вес варианта из действующей версии; null — версия разошлась или вариант не найден */
  score: number | null;
  riskFlag: boolean;
}

export interface QuestionView {
  questionId: string;
  /** Сквозной номер с единицы, как «Питання №1» на кадре */
  number: number;
  title: string;
  answered: boolean;
  options: OptionRow[];
  /**
   * Ответ не из вариантов: текст, число, дата, порядок. На кадре таких
   * пунктов нет, и рисуются они одной залитой строкой без веса.
   */
  free: string | null;
  /** Балл за пункт, который посчитал сервер, — для пунктов без вариантов */
  score: number | null;
}

export interface LadderRow {
  id: string;
  min: number;
  max: number;
  label: string;
  description: string | null;
  severity: Severity;
  /** Ступень, в которую попал балл этого прохождения */
  hit: boolean;
}

export interface ScaleLadder {
  scaleId: string;
  title: string;
  /** Значение в единицах нормировки — в тех же, в каких заданы ступени */
  value: number;
  normalization: ScaleNormalization;
  /** Подпись попавшей полосы от сервера — остаётся, даже когда лестницы нет */
  bandLabel: string | null;
  bandSeverity: Severity | null;
  rows: LadderRow[];
}

export interface ResponseViewModel {
  questions: QuestionView[];
  ladders: ScaleLadder[];
  /** Методика изменена после прохождения: веса и лестницы недоступны */
  stale: boolean;
}

/** Строка ответа, которого нет среди вариантов: текст, число, дата, порядок */
function freeAnswer(a: ResponseDetailAnswer, textById: Map<string, string>): string | null {
  if (a.text) return a.text;
  if (a.number !== null) return String(a.number);
  if (a.date) return a.date;
  if (a.ranking?.length) return a.ranking.map((id) => textById.get(id) ?? id).join(" → ");
  return null;
}

export function buildResponseView(detail: ResponseDetail, survey: SurveyFull): ResponseViewModel {
  const optionById = new Map(survey.questions.flatMap((q) => q.options.map((o) => [o.id, o] as const)));
  const scaleById = new Map(survey.scales.map((s) => [s.id, s] as const));

  /*
   * Признак разошедшейся версии — хоть один вариант или шкала прохождения,
   * которых в действующей методике нет. Идентификаторы версии либо совпадают все,
   * либо не совпадает ни один, поэтому «хоть один» здесь равно «все», а
   * проверка по одному не доверяет этому свойству базы сверх нужного.
   */
  let stale = false;

  const questions: QuestionView[] = [...detail.answers]
    .sort((a, b) => a.position - b.position)
    .map((a, i) => {
      /*
       * Выбранным считается и вариант из optionIds, и значение ячейки
       * матрицы: у матричного пункта ответ — «строка → вариант», и вариант
       * лежит в значениях. Строки самой матрицы (kind === "row") среди
       * вариантов не показываются: это подписи, а не ответы.
       */
      const picked = new Set([...(a.optionIds ?? []), ...Object.values(a.matrix ?? {})]);
      const rowIds = new Set(Object.keys(a.matrix ?? {}));
      const textById = new Map(a.options.map((o) => [o.id, o.text] as const));

      /*
       * Пункт «порядок» — не выбор из вариантов, а их перестановка: ответ —
       * цепочка, и список тех же вариантов под ней показывал бы нуль
       * напротив каждого (вес у порядка позиционный, у варианта его нет).
       * Заключение рисует цепочку; просмотр — тоже, иначе один ответ
       * выглядит на двух экранах двумя разными. Варианты всё же
       * перебираются: по ним ловится чужая версия.
       */
      const chain = a.type === "ranking";
      const rows: OptionRow[] = a.options
        .filter((o) => !rowIds.has(o.id) && optionById.get(o.id)?.kind !== "row")
        .map((o) => {
          const current = optionById.get(o.id);
          if (!current) stale = true;
          return {
            id: o.id,
            text: o.text,
            chosen: picked.has(o.id),
            score: current ? current.score : null,
            riskFlag: o.riskFlag,
          };
        });
      const options = chain ? [] : rows;

      return {
        questionId: a.questionId,
        number: i + 1,
        title: a.title,
        answered: a.answered,
        options,
        free: options.length ? null : freeAnswer(a, textById),
        score: a.score,
      };
    });

  const ladders: ScaleLadder[] = detail.scores.map((sc) => {
    const scale = scaleById.get(sc.scaleId);
    if (!scale) stale = true;
    const bands = scale ? [...scale.bands].sort((x, y) => x.minScore - y.minScore) : [];
    /*
     * Попавшая ступень ищется тем же сравнением, что в движке подсчёта
     * (packages/shared/src/scoring.ts: value >= min && value <= max), и только
     * когда сервер сам нашёл полосу. Без полосы от сервера значение не
     * нормировано — оно не в тех единицах, в которых заданы ступени, и
     * подсветить по нему было бы подсветкой наугад.
     *
     * Запасной путь по подписи — на случай, когда сравнение по значению не
     * сошлось (хранимое значение округлено иначе, чем считалось): сервер
     * помнит подпись полосы на момент подсчёта, и совпадение по ней надёжнее,
     * чем оставить лестницу без подсветки при живой полосе.
     */
    const byValue = sc.band ? bands.find((b) => sc.value >= b.minScore && sc.value <= b.maxScore) : undefined;
    const hitId = byValue?.id ?? (sc.band ? bands.find((b) => b.label === sc.band?.label)?.id : undefined);
    return {
      scaleId: sc.scaleId,
      title: sc.scaleTitle,
      value: sc.value,
      normalization: sc.normalization,
      bandLabel: sc.band?.label ?? null,
      bandSeverity: sc.band?.severity ?? null,
      rows: bands.map((b) => ({
        id: b.id,
        min: b.minScore,
        max: b.maxScore,
        label: b.label,
        description: b.description,
        severity: b.severity,
        hit: b.id === hitId,
      })),
    };
  });

  /*
   * При разошедшейся версии найденные веса и ступени всё равно снимаются:
   * половина совпавших идентификаторов — не «половина правды», а признак,
   * что сопоставление идёт не с той версией, и доверять нельзя ничему.
   */
  if (!stale) return { questions, ladders, stale };
  return {
    stale,
    questions: questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o, score: null })) })),
    ladders: ladders.map((l) => ({ ...l, rows: [] })),
  };
}

/* ═══════════════════ графики прохождения ═══════════════════ */

/*
 * Вкладка «Графіки» того же прохождения (/surveys/:id/responses/:rid/charts):
 * результат на лестнице, динамика этого человека по этой методике, какие
 * ответы дали балл и как человек отвечал. Здесь — только счёт; рисует
 * charts.tsx формами из charts/clinical.tsx.
 *
 * Счёт вынесен сюда по той же причине, что и модель протокола выше: крайние
 * случаи — первое прохождение, смена версии между замерами, неизвестная
 * ошибка измерения, пункт без вариантов, матрица, брошенное прохождение — в
 * браузере воспроизводятся правкой базы, а здесь — одним объектом в тесте
 * (apps/web/test/responseCharts.test.ts). И главное, что эти тесты
 * сторожат: невычислимое остаётся null и на экране становится словом, а не
 * нулём и не NaN на оси.
 */

/** Попавшая полоса со всем, что о ней сказано в методике */
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
export type ShiftVerdict = "reliable" | "within" | "noSem" | "versions";

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
 * Разные версии методики — вердикт «versions», а не RCI: ошибка измерения
 * посчитана в единицах последней версии, а правка ключа одного пункта
 * сдвигает средний балл сама по себе. Неизвестная версия у обоих замеров
 * (прохождения до версионирования) считается одной и той же: так их всё это
 * время и сравнивали.
 */
export function shiftOf(prev: TrendPointView, cur: TrendPointView, sem: number | null): Shift {
  const delta = round2(cur.value - prev.value);
  const base = { delta, prevAt: prev.at, from: prev.band, to: cur.band };
  if ((prev.versionNo ?? null) !== (cur.versionNo ?? null)) return { ...base, verdict: "versions", rci: null };
  if (!(sem !== null && Number.isFinite(sem) && sem > 0)) return { ...base, verdict: "noSem", rci: null };
  const rci = delta / (Math.SQRT2 * sem);
  return { ...base, verdict: Math.abs(rci) > RCI_CRITERION ? "reliable" : "within", rci: round2(rci) };
}

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
      }));
    if (!points.length) continue;
    const i = points.findIndex((p) => p.focus);
    const sem = series.sem != null && Number.isFinite(series.sem) && series.sem > 0 ? series.sem : null;
    scales.push({
      code: sc.scaleCode,
      title: sc.scaleTitle,
      rungs: rungsOf(sc),
      sem,
      points,
      shift: i > 0 ? shiftOf(points[i - 1]!, points[i]!, sem) : null,
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
}

export interface ScaleContribution {
  scaleId: string;
  title: string;
  /** Пункты с ненулевым вкладом, от большего к меньшему */
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
   * правдоподобные, но чужие числа (см. buildResponseView).
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
 * пропущенным не считается: он ответ, просто не числовой.
 */
export function buildContributions(detail: ResponseDetail, survey: SurveyFull): ContributionsView {
  const questionById = new Map(survey.questions.map((q) => [q.id, q] as const));
  const scaleById = new Map(survey.scales.map((s) => [s.id, s] as const));
  const stale =
    survey.versionNumber !== detail.survey.versionNumber ||
    detail.scores.some((sc) => !scaleById.has(sc.scaleId)) ||
    detail.answers.some((a) => !questionById.has(a.questionId));
  if (stale) return { stale: true, scales: [] };

  const answerById = new Map(detail.answers.map((a) => [a.questionId, a] as const));
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
      if (value === null || !Number.isFinite(value) || value === 0) continue;
      const picked = new Set([...(a.optionIds ?? []), ...Object.values(a.matrix ?? {})]);
      items.push({
        questionId: a.questionId,
        number: numberOf.get(a.questionId) ?? 0,
        title: a.title,
        value: round2(value),
        max: round2(max),
        critical: a.options.some((o) => o.riskFlag && picked.has(o.id)),
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
