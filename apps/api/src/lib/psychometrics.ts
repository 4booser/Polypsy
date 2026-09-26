import {
  TOO_FAST_MS,
  type FloorCeiling,
  type ItemStat,
  type QualityFlags,
  type Question,
  type Reliability,
  type ScaleShape,
} from "@quizzy/shared";
import { SMALL_CELL_FLOOR } from "./privacy";
import {
  average,
  cronbachAlpha,
  kurtosisExcess,
  median,
  pearson,
  quantile,
  round,
  skewness,
  stdev,
  variance,
} from "./stats";

/**
 * Порог, ниже которого ответ считается слишком быстрым для осмысленного
 * чтения пункта. Само число — в @quizzy/shared: по той же мерке графики
 * прохождения выделяют быстрые ответы на клиенте, и копия здесь разошлась бы
 * с той при первой правке.
 */
export { TOO_FAST_MS };

/**
 * Сколько прохождений нужно, чтобы говорить о различающей силе пункта.
 *
 * Стандартная ошибка корреляции около нуля равна 1/√(n−1) (Fisher, 1921):
 * на тридцати прохождениях это 0.19 — то есть пункт с истинной корреляцией
 * ноль выдаёт наблюдаемые 0.2 просто так, а мы по этому числу решаем, годен
 * пункт или его выбросить из методики. Тридцать — минимум, при котором
 * решение хотя бы не случайно; на сотне ошибка падает до 0.1, и только там
 * различие 0.2 против 0.35 становится осмысленным.
 *
 * Ниже порога отдаётся null у решения (`discriminating`) и у доли
 * срабатывания, а не «примерно 0.2»: цифра без права на вывод хуже прочерка,
 * потому что по ней всё равно делают вывод.
 */
export const MIN_N_ITEM_STATS = 30;

/**
 * Ниже этой корреляции пункт не различает людей.
 *
 * Классический порог отбраковки: Nunnally & Bernstein (1994), «Psychometric
 * Theory», гл. 8 — исправленная корреляция пункта с суммой ниже 0.2 означает,
 * что пункт меряет не то же, что шкала, и его вклад в сумму — шум. Порог
 * мягкий намеренно: 0.3 у Nunnally рекомендован для разработки новой шкалы,
 * а у методики из пособия пункт нельзя выкинуть — по нему можно только
 * предупредить, что он ничего не добавляет.
 */
export const WEAK_ITEM_LIMIT = 0.2;

/**
 * Надёжность субшкалы и вклад каждого пункта.
 *
 * scores[responseId][questionId] — балл пункта на момент прохождения.
 * Считаем только по прохождениям, где отвечены все пункты шкалы: частичные
 * профили смещают и альфу, и корреляции.
 */
export function reliabilityOf(
  items: Question[],
  scores: Map<string, Map<string, number>>,
): Reliability | null {
  if (items.length < 2) return null;

  const complete: number[][] = [];
  for (const byQuestion of scores.values()) {
    const row = items.map((q) => byQuestion.get(q.id));
    if (row.some((v) => v === undefined)) continue;
    complete.push(row as number[]);
  }
  if (complete.length < 3) return null;

  const alpha = cronbachAlpha(complete);
  if (alpha === null) return null;

  const enough = complete.length >= MIN_N_ITEM_STATS;

  const itemStats: ItemStat[] = items.map((question, index) => {
    const own = complete.map((row) => row[index]!);
    // исправленная корреляция: пункт против суммы ОСТАЛЬНЫХ пунктов,
    // иначе пункт коррелирует сам с собой и величина завышена
    const rest = complete.map((row) => row.reduce((sum, v, i) => (i === index ? sum : sum + v), 0));

    const withoutItem = complete.map((row) => row.filter((_, i) => i !== index));
    const alphaIfDeleted = items.length > 2 ? cronbachAlpha(withoutItem) : null;

    /*
     * Доля срабатывания пункта: сколько прохождений дали вклад выше его же
     * минимума. Для ключевых пунктов (вклад 0/1) это классический
     * endorsement rate, и корреляция такого пункта с суммой остальных —
     * ровно точечно-бисериальная: формула Пирсона на дихотомической
     * переменной и есть r_pb (Lord & Novick, 1968, §15.4), отдельной
     * реализации она не требует.
     *
     * Доли по КАЖДОМУ варианту ответа считаются не здесь, а в разборе
     * вопроса (questions[].options): там они уже есть, и второй счёт того же
     * по другому пути — это два числа, которые однажды разойдутся.
     */
    const lowest = Math.min(...own);
    const endorsed = own.filter((v) => v > lowest).length;

    return {
      questionId: question.id,
      title: question.title,
      itemTotalCorrelation: round(pearson(own, rest), 3),
      alphaIfDeleted: alphaIfDeleted === null ? null : round(alphaIfDeleted, 3),
      variance: round(variance(own), 3),
      endorsement: enough ? round((endorsed / complete.length) * 100, 1) : null,
      discriminating: enough ? round(pearson(own, rest), 3) >= WEAK_ITEM_LIMIT : null,
    };
  });

  return {
    alpha: round(alpha, 3),
    itemCount: items.length,
    items: itemStats,
    sampleN: complete.length,
    omega: omegaTotal(complete),
    weakItems: enough ? itemStats.filter((i) => i.discriminating === false).length : null,
  };
}

interface AnswerLike {
  questionId: string;
  durationMs: number;
  optionIds?: string[] | null;
  number?: number | null;
  matrix?: Record<string, string> | null;
  skipped?: boolean;
}

/**
 * Признаки небрежного заполнения.
 *
 * Два независимых маркера: слишком быстрые ответы и «прямая линия» — серия
 * одинаковых выборов подряд. Ни один сам по себе не доказывает недобросовестность,
 * поэтому результат называется флагом и требует взгляда специалиста, а не
 * автоматического исключения из выборки.
 */
export function qualityOf(
  responseId: string,
  respondent: string | null,
  submittedAt: string | null,
  durationMs: number,
  answers: AnswerLike[],
  questions: Question[],
  tooFastMs: number = TOO_FAST_MS,
  /** Ошибки Гуттмана по ключевой шкале, если её удалось построить */
  personFit: number | null = null,
): QualityFlags {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const answered = answers.filter((a) => !a.skipped);

  const timed = answered.filter((a) => a.durationMs > 0);
  const tooFast = timed.filter((a) => a.durationMs < tooFastMs).length;
  const tooFastShare = timed.length ? round((tooFast / timed.length) * 100, 1) : 0;

  let longestStraightLine = 0;

  // внутри матричного вопроса: одинаковый столбец во всех строках
  for (const a of answered) {
    const q = byId.get(a.questionId);
    if (q?.type !== "matrix" || !a.matrix) continue;
    const picks = Object.values(a.matrix);
    if (picks.length > 1 && new Set(picks).size === 1) {
      longestStraightLine = Math.max(longestStraightLine, picks.length);
    }
  }

  // между вопросами: подряд идущие одинаковые числовые ответы
  let run = 1;
  const numeric = answered
    .map((a) => ({ q: byId.get(a.questionId), value: a.number }))
    .filter((x) => x.q && ["scale", "slider", "number"].includes(x.q.type));
  for (let i = 1; i < numeric.length; i++) {
    if (numeric[i]!.value !== null && numeric[i]!.value === numeric[i - 1]!.value) {
      run++;
      longestStraightLine = Math.max(longestStraightLine, run);
    } else {
      run = 1;
    }
  }

  const reasons: string[] = [];
  if (tooFastShare >= 50) reasons.push(`${tooFastShare}% ответов быстрее ${tooFastMs} мс`);
  if (longestStraightLine >= 5) reasons.push(`серия из ${longestStraightLine} одинаковых ответов`);
  if (answered.length >= 5 && durationMs > 0 && durationMs < answered.length * tooFastMs) {
    reasons.push("общее время меньше минимально правдоподобного");
  }
  /*
   * Person-fit: профиль, где трудные пункты сработали, а лёгкие нет, — не
   * «плохой человек», а нетипичный паттерн: небрежность, симуляция или
   * непонятая инструкция. Формулировка нейтральна намеренно.
   */
  if (personFit !== null && personFit >= 0.4) {
    reasons.push(`нетипичный паттерн ответов (${personFit})`);
  }

  return {
    responseId,
    respondent,
    submittedAt,
    durationMs,
    tooFastShare,
    longestStraightLine,
    personFit,
    flagged: reasons.length > 0,
    reasons,
  };
}

/**
 * Сколько прохождений нужно, чтобы однофакторное решение было устойчивым.
 *
 * Guadagnoli & Velicer (1988), Psychol Bull 103(2), 265–275: компонента
 * воспроизводится на выборке от пятидесяти, если у неё хотя бы четыре
 * нагрузки выше 0.6 — типичный случай клинической субшкалы. Ниже пятидесяти
 * первая компонента пляшет от выборки к выборке, и ω вместе с ней.
 */
export const MIN_N_OMEGA = 50;
/** Однофакторная модель на двух пунктах не определена: нагрузок больше, чем уравнений */
const MIN_ITEMS_OMEGA = 3;

/**
 * Омега Макдональда по однофакторной модели — рядом с альфой, а не вместо.
 *
 *   ω = (Σλᵢ)² / ((Σλᵢ)² + Σψᵢ)
 *
 * Источник: McDonald (1999), «Test Theory: A Unified Treatment», гл. 6;
 * практическая аргументация — Dunn, Baguley & Brunsdon (2014), Br J Psychol
 * 105(3), 399–412. Зачем она: альфа равна надёжности только при тау-
 * эквивалентности (все пункты грузят фактор ОДИНАКОВО). У реальной шкалы
 * пункты разновесны, и альфа систематически занижает надёжность — по ней
 * списывают годные шкалы и отменяют выводы, которые шкала делала верно.
 *
 * ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ ПОЛНОЦЕННОЙ ω. Нагрузки λ здесь взяты из первой
 * ГЛАВНОЙ КОМПОНЕНТЫ ковариационной матрицы, а не из факторного анализа
 * (ML или MINRES). Разница принципиальная: главная компонента объясняет всю
 * дисперсию пунктов, включая уникальную, и потому завышает нагрузки, а с
 * ними и ω — тем сильнее, чем меньше пунктов и чем слабее они связаны. На
 * шкале из четырёх слабых пунктов завышение доходит до 0.05–0.08.
 * Отвергнутая альтернатива — тянуть в сервер библиотеку факторного анализа:
 * она принесла бы итеративную оценку, которая не сходится на вырожденных
 * матрицах, и молчаливо возвращала бы NaN там, где сейчас честный null.
 *
 * Отсюда правило чтения: ω ЗДЕСЬ — ВЕРХНЯЯ ОЦЕНКА. Ей можно верить, когда
 * она подтверждает альфу или близка к ней; ей нельзя верить, когда она одна
 * вытягивает шкалу выше порога приемлемости при низкой альфе — это ровно тот
 * случай, где завышение и работает. Двухфакторную шкалу она тоже не увидит:
 * однофакторная модель на ней неверна в принципе, и число получится
 * осмысленное с виду и бессмысленное по сути.
 *
 * null: пунктов меньше трёх, наблюдений меньше MIN_N_OMEGA, нулевая
 * дисперсия у всей матрицы, вырожденная первая компонента.
 */
export function omegaTotal(rows: number[][]): number | null {
  const complete = rows.filter((r) => r.length > 0);
  if (complete.length < MIN_N_OMEGA) return null;
  const k = complete[0]!.length;
  if (k < MIN_ITEMS_OMEGA) return null;
  if (complete.some((r) => r.length !== k)) return null;

  const means = new Array<number>(k).fill(0);
  for (const row of complete) for (let i = 0; i < k; i++) means[i]! += row[i]!;
  for (let i = 0; i < k; i++) means[i]! /= complete.length;

  // ковариации с делителем n−1 — та же несмещённая оценка, что и в variance
  const cov: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (const row of complete) {
    for (let i = 0; i < k; i++) {
      for (let j = i; j < k; j++) {
        const add = (row[i]! - means[i]!) * (row[j]! - means[j]!);
        cov[i]![j]! += add;
        if (i !== j) cov[j]![i]! += add;
      }
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) cov[i]![j]! /= complete.length - 1;

  const totalVar = cov.reduce((s, r, i) => s + r[i]!, 0);
  if (!(totalVar > 0)) return null;

  /*
   * Первая компонента степенным методом. Сто итераций — с запасом: отношение
   * первого и второго собственных чисел у согласованной шкалы велико, и
   * сходимость наступает за десяток. Отвергнутая альтернатива — полное
   * разложение Якоби: оно даёт все k компонент, из которых нужна одна.
   */
  let vec = new Array<number>(k).fill(1 / Math.sqrt(k));
  let eigen = 0;
  for (let step = 0; step < 100; step++) {
    const next = new Array<number>(k).fill(0);
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) next[i]! += cov[i]![j]! * vec[j]!;
    }
    const norm = Math.sqrt(next.reduce((s, v) => s + v * v, 0));
    if (!(norm > 0)) return null;
    for (let i = 0; i < k; i++) next[i]! /= norm;
    eigen = norm;
    let shift = 0;
    for (let i = 0; i < k; i++) shift += Math.abs(next[i]! - vec[i]!);
    vec = next;
    if (shift < 1e-12) break;
  }
  if (!(eigen > 0)) return null;

  // знак собственного вектора произволен; фактор ориентируем «по шкале вверх»
  const sign = vec.reduce((s, v) => s + v, 0) < 0 ? -1 : 1;
  const loadings = vec.map((v) => sign * v * Math.sqrt(eigen));

  const sumLoad = loadings.reduce((s, v) => s + v, 0);
  // уникальная дисперсия не бывает отрицательной: случай Хейвуда режем нулём
  const sumUnique = loadings.reduce((s, l, i) => s + Math.max(0, cov[i]![i]! - l * l), 0);
  const denom = sumLoad * sumLoad + sumUnique;
  if (!(denom > 0)) return null;

  const omega = (sumLoad * sumLoad) / denom;
  return Number.isFinite(omega) ? round(omega, 3) : null;
}

/**
 * Пол и потолок шкалы: доля прохождений, упёршихся в её края.
 *
 * Источник порога 15%: Terwee et al. (2007), J Clin Epidemiol 60(1), 34–42 —
 * критерии COSMIN для оценки инструмента. Смысл не статистический, а
 * практический: если каждый седьмой набрал минимум, шкала на этом краю не
 * различает людей вовсе — между «совсем ничего» и «почти ничего» она выдаёт
 * одно и то же число. Специалист, который этого не знает, читает ноль как
 * благополучие, а динамику от нуля — как отсутствие изменений, хотя шкала
 * просто не может показать движение вниз.
 *
 * Врёт при n < MIN_N_FLOOR_CEILING: доля 15% на выборке из тридцати имеет
 * стандартную ошибку √(0.15·0.85/30) ≈ 6.5 п.п., то есть «17%» и «9%»
 * статистически одно и то же, а решение по ним разное. Те же пятьдесят
 * наблюдений требуют и критерии Terwee для положительной оценки.
 */
export const MIN_N_FLOOR_CEILING = 50;
/** Выше этой доли край шкалы считается нерабочим (Terwee, 2007) */
export const FLOOR_CEILING_LIMIT = 15;

export function floorCeiling(
  raw: number[],
  minPossible: number,
  maxPossible: number,
): FloorCeiling | null {
  if (!raw.length) return null;
  // границы должны быть настоящими границами, иначе «упёрся в край» бессмысленно
  if (!Number.isFinite(minPossible) || !Number.isFinite(maxPossible)) return null;
  if (maxPossible <= minPossible) return null;

  if (raw.length < MIN_N_FLOOR_CEILING) {
    return { n: raw.length, floorPercent: null, ceilingPercent: null, floorProblem: null, ceilingProblem: null };
  }

  const atFloor = raw.filter((v) => v <= minPossible).length;
  const atCeiling = raw.filter((v) => v >= maxPossible).length;
  const floorPercent = round((atFloor / raw.length) * 100, 1);
  const ceilingPercent = round((atCeiling / raw.length) * 100, 1);
  return {
    n: raw.length,
    floorPercent,
    ceilingPercent,
    floorProblem: floorPercent > FLOOR_CEILING_LIMIT,
    ceilingProblem: ceilingPercent > FLOOR_CEILING_LIMIT,
  };
}

/**
 * Сколько наблюдений нужно форме распределения.
 *
 * Перцентили: на выборке меньше двадцати крайние (5-й и 95-й) не считаются,
 * а интерполируются между двумя крайними наблюдениями — то есть показывают
 * самого быстрого и самого медленного человека под видом квантиля. Двадцать —
 * тот минимум, при котором в каждый пятипроцентный хвост попадает хотя бы
 * одно настоящее наблюдение.
 *
 * Асимметрия и эксцесс: SE(G1) ≈ √(6/n), SE(G2) ≈ √(24/n) (Cramér, 1946,
 * §28.5). При n = 50 это 0.35 и 0.69 — уже можно отличить «сильно скошено»
 * от «симметрично», при n = 30 нельзя. Cain, Zhang & Yuan (2017), Behav Res
 * Methods 49(5), называют те же полсотни минимумом для описания формы.
 */
export const MIN_N_PERCENTILES = 20;
export const MIN_N_SHAPE = 50;

/**
 * Описание распределения шкалы с честными пропусками.
 *
 * Порог малых ячеек здесь не «ещё одна проверка», а первая: среднее и
 * медиана по трём прохождениям — это почти поимённые данные, а не сводка,
 * и по ним в подразделении из четырёх человек узнают конкретного.
 */
export function scaleShape(values: number[]): ScaleShape {
  const n = values.length;
  const empty: ScaleShape = {
    n, mean: null, median: null, sd: null, skewness: null, kurtosis: null, percentiles: null,
  };
  if (n < SMALL_CELL_FLOOR) return empty;

  const shaped = n >= MIN_N_SHAPE;
  const sorted = [...values].sort((a, b) => a - b);
  // нулевой разброс возвращает null из самих формул — не подставляем ноль
  const skew = shaped ? skewness(values) : null;
  const kurt = shaped ? kurtosisExcess(values) : null;
  return {
    n,
    mean: round(average(values), 2),
    median: round(median(values), 2),
    sd: round(stdev(values), 2),
    skewness: skew === null ? null : round(skew, 3),
    kurtosis: kurt === null ? null : round(kurt, 3),
    percentiles:
      n >= MIN_N_PERCENTILES
        ? {
            p5: round(quantile(sorted, 0.05), 2),
            p10: round(quantile(sorted, 0.1), 2),
            p25: round(quantile(sorted, 0.25), 2),
            p50: round(quantile(sorted, 0.5), 2),
            p75: round(quantile(sorted, 0.75), 2),
            p90: round(quantile(sorted, 0.9), 2),
            p95: round(quantile(sorted, 0.95), 2),
          }
        : null,
  };
}
