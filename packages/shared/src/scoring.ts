import { t, type Answer, type ProfileResult, type Question, type Scale, type ScaleItem, type ScoreResult, type Sex, type SurveyFull } from "./types";

/** Диапазон баллов, который вопрос может дать субшкале */
export function questionScoreRange(question: Question): { min: number; max: number } {
  switch (question.type) {
    case "single":
    case "yesno": {
      const scores = question.options.filter((o) => o.kind === "option").map((o) => o.score);
      return scores.length ? { min: Math.min(...scores), max: Math.max(...scores) } : { min: 0, max: 0 };
    }
    case "multiple": {
      // при множественном выборе можно набрать сумму всех положительных баллов
      const scores = question.options.filter((o) => o.kind === "option").map((o) => o.score);
      const positive = scores.filter((s) => s > 0).reduce((a, b) => a + b, 0);
      const negative = scores.filter((s) => s < 0).reduce((a, b) => a + b, 0);
      return { min: negative, max: positive };
    }
    case "matrix": {
      const rows = question.options.filter((o) => o.kind === "row").length;
      const scores = question.options.filter((o) => o.kind === "option").map((o) => o.score);
      if (!scores.length || !rows) return { min: 0, max: 0 };
      return { min: Math.min(...scores) * rows, max: Math.max(...scores) * rows };
    }
    case "scale":
    case "slider":
    case "number":
      return { min: question.minValue ?? 0, max: question.maxValue ?? 0 };
    default:
      return { min: 0, max: 0 };
  }
}

/** Сырой балл за ответ, до применения обратного ключа */
function rawAnswerScore(question: Question, answer: Answer | undefined): number | null {
  if (!answer || answer.skipped) return null;
  const byId = new Map(question.options.map((o) => [o.id, o]));

  switch (question.type) {
    case "single":
    case "yesno": {
      const id = answer.optionIds?.[0];
      if (!id) return null;
      return byId.get(id)?.score ?? 0;
    }
    case "multiple": {
      const ids = answer.optionIds ?? [];
      if (!ids.length) return null;
      return ids.reduce((sum, id) => sum + (byId.get(id)?.score ?? 0), 0);
    }
    case "matrix": {
      const picks = Object.values(answer.matrix ?? {});
      if (!picks.length) return null;
      return picks.reduce((sum, id) => sum + (byId.get(id)?.score ?? 0), 0);
    }
    case "scale":
    case "slider":
    case "number":
      return answer.number ?? null;
    default:
      return null;
  }
}

/**
 * Балл за ответ с учётом обратного ключа.
 * Обратный ключ — стандартный приём психометрики: часть пунктов формулируется
 * в противоположную сторону, чтобы бороться с согласительным смещением,
 * и их балл инвертируется внутри диапазона вопроса.
 */
export function answerScore(question: Question, answer: Answer | undefined): number | null {
  const raw = rawAnswerScore(question, answer);
  if (raw === null) return null;
  if (!question.reverseScored) return raw;
  const { min, max } = questionScoreRange(question);
  return min + max - raw;
}

/** Максимально возможный вклад пункта в шкалу по её ключу */
function itemMaxContribution(question: Question, item: ScaleItem): number {
  if (item.matchKey !== null) return item.weight;
  const range = questionScoreRange(question);
  return Math.max(Math.abs(range.min), Math.abs(range.max)) * item.weight;
}

/** Вклад конкретного ответа в шкалу */
export function itemContribution(
  question: Question,
  item: ScaleItem,
  answer: Answer | undefined,
): number | null {
  if (!answer || answer.skipped) return null;

  // режим ключа: совпал ли выбранный вариант с ожидаемым «Да»/«Нет»
  if (item.matchKey !== null) {
    const picked = new Set([...(answer.optionIds ?? []), ...Object.values(answer.matrix ?? {})]);
    const matched = question.options.some((o) => picked.has(o.id) && o.keyCode === item.matchKey);
    return matched ? item.weight : 0;
  }

  const score = answerScore(question, answer);
  return score === null ? null : score * item.weight;
}

/** Максимально возможный балл субшкалы — нужен для процента и нормирования */
export function scaleMaxScore(scale: Scale, questions: Question[]): number {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const contributions = scale.items
    .map((item) => {
      const q = byId.get(item.questionId);
      return q ? itemMaxContribution(q, item) : 0;
    });
  if (!contributions.length) return 0;

  if (scale.aggregation === "average") {
    return contributions.reduce((a, b) => a + b, 0) / contributions.length;
  }
  if (scale.aggregation === "count") return contributions.length;
  return contributions.reduce((a, b) => a + b, 0);
}

/** Норма, подходящая респонденту по полу и возрасту */
function pickNorm<T extends { sex: Sex | null; ageMin: number | null; ageMax: number | null }>(
  rows: T[],
  sex: Sex | null,
  age: number | null,
): T | null {
  const fits = (r: T) =>
    (r.sex === null || r.sex === sex) &&
    (r.ageMin === null || (age !== null && age >= r.ageMin)) &&
    (r.ageMax === null || (age !== null && age <= r.ageMax));
  // сначала ищем самую конкретную норму, потом общую
  return (
    rows.filter(fits).sort((a, b) => Number(b.sex !== null) - Number(a.sex !== null))[0] ?? null
  );
}

export interface RespondentContext {
  sex: Sex | null;
  age: number | null;
}

/**
 * Подсчёт профиля.
 *
 * Порядок обязателен и продиктован методиками:
 *   1. сырые баллы всех шкал по ключам;
 *   2. поправки одной шкалы на другую (K-коррекция Мини-мульта) — только после
 *      того, как посчитаны все сырые баллы, иначе поправка зависела бы от порядка;
 *   3. нормирование: доля, T-балл или стен;
 *   4. подбор интерпретационной полосы по итоговому значению;
 *   5. проверка шкал достоверности.
 */
export function computeProfile(
  survey: SurveyFull,
  answers: Answer[],
  respondent: RespondentContext = { sex: null, age: null },
): ProfileResult {
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const questionById = new Map(survey.questions.map((q) => [q.id, q]));

  // 1. сырые баллы
  const raw = new Map<string, number>();
  for (const scale of survey.scales) {
    const values: number[] = [];
    for (const item of scale.items) {
      const question = questionById.get(item.questionId);
      if (!question) continue;
      const contribution = itemContribution(question, item, byQuestion.get(item.questionId));
      if (contribution !== null) values.push(contribution);
    }

    let value = 0;
    if (scale.aggregation === "average") {
      value = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    } else if (scale.aggregation === "count") {
      value = values.filter((v) => v > 0).length;
    } else {
      value = values.reduce((a, b) => a + b, 0);
    }
    raw.set(scale.code, Math.round(value * 1000) / 1000);
  }

  // 2. поправки — по сырым значениям, не по уже поправленным
  const corrected = new Map<string, number>(raw);
  for (const scale of survey.scales) {
    let value = raw.get(scale.code) ?? 0;
    for (const correction of scale.corrections) {
      value += (raw.get(correction.sourceScaleCode) ?? 0) * correction.coefficient;
    }
    corrected.set(scale.code, Math.round(value * 1000) / 1000);
  }

  const warnings: string[] = [];
  let reliable = true;

  const scores: ScoreResult[] = survey.scales.map((scale) => {
    const rawScore = raw.get(scale.code) ?? 0;
    const correctedScore = corrected.get(scale.code) ?? 0;
    const maxScore = Math.round(scaleMaxScore(scale, survey.questions) * 100) / 100;

    /*
     * 3. Нормирование — и отметка о том, удалось ли оно.
     *
     * `normalized` существует потому, что полосы интерпретации и пороги
     * шкал достоверности заданы В ЕДИНИЦАХ НОРМИРОВКИ: T-баллах, стенах,
     * долях. Если нормировать не вышло — нормы для этого пола нет, балл
     * вне таблицы стенов, знаменатель нулевой, — в `value` остаётся сырой
     * балл, и применять к нему те же полосы и пороги нельзя.
     *
     * Раньше применялись. Мини-мульт с неизвестным полом давал по всем
     * одиннадцати шкалам «Низкий» и severity none: сырой балл 0–20 всегда
     * попадает в полосу 0–44.9. А порог шкалы лжи в 70 T-баллов сырым
     * баллом (максимум 5) не достигается никогда — шкала лжи выключалась
     * молча. Проверено запуском: те же ответы дают T=90 и «недостоверно»
     * при известном поле и «достоверно, норма» при неизвестном.
     */
    let value = correctedScore;
    let normalized = true;
    if (scale.normalization === "raw") {
      // сырой балл и есть итог — полосы заданы в тех же единицах
    } else if (scale.normalization === "ratio") {
      const denominator = scale.ratioDenominator ?? maxScore;
      if (denominator > 0) {
        value = Math.round((correctedScore / denominator) * 1000) / 1000;
      } else {
        normalized = false;
        warnings.push(
          `Шкала «${t(scale.title)}»: не задан знаменатель доли, показан сырой балл`,
        );
      }
    } else if (scale.normalization === "tscore") {
      const norm = pickNorm(scale.norms, respondent.sex, respondent.age);
      if (norm && norm.sd > 0) {
        value = Math.round((50 + (10 * (correctedScore - norm.mean)) / norm.sd) * 10) / 10;
      } else {
        normalized = false;
        warnings.push(
          norm
            ? `Шкала «${t(scale.title)}»: у нормы нулевое стандартное отклонение, показан сырой балл`
            : `Шкала «${t(scale.title)}»: нет нормы для этого пола и возраста, показан сырой балл`,
        );
      }
    } else if (scale.normalization === "sten") {
      const row = scale.stenTable.find(
        (r) =>
          (r.sex === null || r.sex === respondent.sex) &&
          (r.ageMin === null || (respondent.age !== null && respondent.age >= r.ageMin)) &&
          (r.ageMax === null || (respondent.age !== null && respondent.age <= r.ageMax)) &&
          correctedScore >= r.rawMin &&
          correctedScore <= r.rawMax,
      );
      if (row) value = row.sten;
      else {
        normalized = false;
        warnings.push(`Шкала «${t(scale.title)}»: сырой балл вне таблицы стенов`);
      }
    }

    // 4. Полоса — только по нормированному значению. Ненормированное
    //    значение не в тех единицах, в которых полосы заданы.
    const band = normalized
      ? (scale.bands.find((b) => value >= b.minScore && value <= b.maxScore) ?? null)
      : null;

    /*
     * 5. Гейт достоверности.
     *
     * Если шкалу достоверности не удалось нормировать, протокол считается
     * НЕдостоверным. Это не перестраховка: «мы не смогли проверить, честно
     * ли заполнен бланк» и «бланк заполнен честно» — разные утверждения, и
     * выдавать первое за второе в заключении нельзя. Заодно это создаёт
     * давление заполнить пол и возраст, то есть чинит причину.
     */
    let validityFailed: boolean | undefined;
    if (scale.kind === "validity" && scale.validityThreshold !== null) {
      if (!normalized) {
        reliable = false;
        warnings.push(
          `Шкалу достоверности «${t(scale.title)}» проверить не удалось: результат не нормирован`,
        );
      } else {
        validityFailed =
          scale.validityDirection === "below"
            ? value < scale.validityThreshold
            : value > scale.validityThreshold;
        if (validityFailed) {
          reliable = false;
          warnings.push(
            t(scale.validityMessage) ||
              `Шкала достоверности «${t(scale.title)}» вышла за порог ${scale.validityThreshold} — результат ненадёжен`,
          );
        }
      }
    }

    return {
      scaleId: scale.id,
      scaleCode: scale.code,
      scaleTitle: t(scale.title),
      kind: scale.kind,
      rawScore,
      correctedScore,
      value,
      normalized,
      normalization: scale.normalization,
      maxScore,
      percent: maxScore > 0 ? Math.round((correctedScore / maxScore) * 1000) / 10 : 0,
      band: band
        ? {
            label: t(band.label),
            severity: band.severity,
            description: band.description ? t(band.description) : null,
            grade: band.grade,
            recommendation: band.recommendation ? t(band.recommendation) : null,
          }
        : null,
      ...(validityFailed !== undefined ? { validityFailed } : {}),
    };
  });

  return { scores, reliable, warnings };
}

/** Обратная совместимость: только содержательные шкалы, без гейта достоверности */
export function computeScores(
  survey: SurveyFull,
  answers: Answer[],
  respondent?: RespondentContext,
): ScoreResult[] {
  return computeProfile(survey, answers, respondent).scores;
}

/** Считается ли вопрос отвеченным — общая проверка для клиента и сервера */
export function isAnswered(question: Question, answer: Answer | undefined): boolean {
  if (!answer || answer.skipped) return false;
  switch (question.type) {
    case "single":
    case "multiple":
    case "yesno":
      return (answer.optionIds?.length ?? 0) > 0;
    case "matrix": {
      const rows = question.options.filter((o) => o.kind === "row");
      const filled = Object.keys(answer.matrix ?? {}).length;
      return filled >= rows.length && rows.length > 0;
    }
    case "ranking": {
      const choices = question.options.filter((o) => o.kind === "option");
      return (answer.ranking?.length ?? 0) === choices.length && choices.length > 0;
    }
    case "scale":
    case "slider":
    case "number":
      return typeof answer.number === "number";
    case "text":
    case "longtext":
      return !!answer.text?.trim();
    case "date":
      return !!answer.date;
    case "info":
      return true;
  }
}

/** Проходит ли вопрос по условной логике при текущих ответах */
export function isQuestionVisible(question: Question, questions: Question[], answers: Map<string, Answer>): boolean {
  if (!question.logic.length) return true;
  const byId = new Map(questions.map((q) => [q.id, q]));

  // все правила должны выполняться: show — включает, hide — исключает
  return question.logic.every((rule) => {
    const source = byId.get(rule.sourceQuestionId);
    const answer = answers.get(rule.sourceQuestionId);
    const matched = source ? evaluateRule(source, answer, rule.operator, rule.value) : false;
    return rule.action === "show" ? matched : !matched;
  });
}

function evaluateRule(
  source: Question,
  answer: Answer | undefined,
  operator: string,
  value: unknown,
): boolean {
  if (operator === "answered") return isAnswered(source, answer);
  if (operator === "not_answered") return !isAnswered(source, answer);
  if (!answer) return false;

  if (operator === "contains") {
    const ids = answer.optionIds ?? [];
    return ids.includes(String(value));
  }
  if (operator === "eq" || operator === "neq") {
    const picked = answer.optionIds?.[0] ?? answer.text ?? answer.number ?? answer.date;
    const equal = String(picked) === String(value);
    return operator === "eq" ? equal : !equal;
  }

  const numeric = answer.number ?? answerScore(source, answer);
  if (numeric === null || numeric === undefined || typeof value !== "number") return false;
  switch (operator) {
    case "gt":
      return numeric > value;
    case "gte":
      return numeric >= value;
    case "lt":
      return numeric < value;
    case "lte":
      return numeric <= value;
    default:
      return false;
  }
}

/**
 * Однородная выборка баллов одной шкалы.
 *
 * У шкалы с нормами балл приводится к общей единице — T, стенам, доле. Но
 * норма может быть задана не для всех: женская норма легко теряется, и тогда
 * у части людей в той же колонке лежит СЫРОЙ балл (см. `normalized` выше —
 * он становится ложью ровно в этом случае, а у сырых шкал остаётся истиной).
 *
 * Складывать их нельзя: одной женщины без нормы хватало, чтобы средний
 * T-балл подразделения перестал что-либо значить — в проверке среднее
 * выходило 25,5 вместо 50.
 *
 * Правило простое и оно же безопасное: если хоть один балл приведён, берём
 * только приведённые; если не приведён ни один — шкала целиком в сырых
 * единицах, и они сравнимы между собой. Смешанной выборки не бывает никогда.
 */
export function comparableScores<T extends { value: number; normalized: boolean }>(
  scores: T[],
): { values: number[]; kept: T[]; dropped: number } {
  const normalized = scores.filter((s) => s.normalized);
  const kept = normalized.length ? normalized : scores;
  return { values: kept.map((s) => s.value), kept, dropped: scores.length - kept.length };
}
