import { computeProfile, isQuestionVisible, type RespondentContext } from "./scoring";
import type { Answer, ProfileResult, Question, RiskSeverity, ScoreResult, SurveyFull } from "./types";

/**
 * Оценка сдачи целиком: что идёт в подсчёт, какие баллы и какой риск.
 *
 * Одна функция на всех, кто это решает, — сервер при записи, мобилка и
 * веб-кабинет без сети. До волны 12 каждый решал сам. Сервер искал риск по
 * критическим вариантам, числовым порогам, ответам матрицы и полосам шкал;
 * клиенты без сети — почти только по флагу варианта, а мобилка при
 * выключенном подсчёте не проверяла риск вовсе. Кризисная карточка, ради
 * которой офлайн-проверка и существует, пропадала ровно тогда, когда сети
 * нет: у человека с 9 из 10 по числовому пункту о суицидальных мыслях или с
 * тяжёлой полосой шкалы. И на самом сервере риск считался трижды по-разному:
 * тревогу поднимали и ответы, и полосы, правила поддержки решений слышали
 * только ответы, карточка зависела от их числа.
 *
 * Поэтому здесь и только здесь:
 *   1. какие ответы считаются — только на видимые по условной логике;
 *   2. профиль — тем же computeProfile, если у методики включён подсчёт;
 *   3. риск — критические ответы и полосы содержательных шкал вместе, с
 *      одной итоговой тяжестью, из которой берут тревога, правила и карточка.
 *
 * Подсчёт выключен — нет баллов, а значит, и полос; но критические ответы
 * проверяются всегда: выключенный подсчёт — решение о том, показывать ли
 * числа, а не о том, звать ли на помощь.
 */

/** Критический ответ: выбранный вариант с флагом риска или числовой ответ на пороге */
export interface AnswerRisk {
  questionId: string;
  label: string;
  severity: RiskSeverity;
}

/** Полоса содержательной шкалы, в которую лёг балл: умеренная или тяжёлая */
export interface BandRisk {
  scaleId: string;
  label: string;
  severity: RiskSeverity;
}

/** Итоговый риск сдачи */
export interface SubmissionRisk {
  answers: AnswerRisk[];
  bands: BandRisk[];
  /** Худшая тяжесть из всех сигналов; null — сигналов нет */
  severity: RiskSeverity | null;
}

export interface SubmissionEvaluation {
  /** Ответы, которые идут в подсчёт, риск и запись */
  answers: Answer[];
  /**
   * Вопросы, ответы на которые пришли, но вопрос скрыт условием показа.
   * Такие ответы отброшены; вызывающий решает, куда об этом написать.
   */
  hidden: string[];
  profile: ProfileResult;
  risk: SubmissionRisk;
}

const WEIGHT: Record<RiskSeverity, number> = { moderate: 1, severe: 2 };

function worse(a: RiskSeverity | null, b: RiskSeverity): RiskSeverity {
  return a === null || WEIGHT[b] > WEIGHT[a] ? b : a;
}

/**
 * Ответы, которые считаются: на существующие вопросы, видимые при этих ответах.
 *
 * Видимость решается ТЕМ ЖЕ правилом, что на экране (isQuestionVisible по
 * полному набору ответов), и тем же, что при проверке обязательности на
 * сервере. Проверка пропускала скрытые пункты, а подсчёт и поиск риска
 * получали исходный массив — ответ, оставшийся от прежней ветки (человек
 * ответил, вернулся и сменил развилку) или просто присланный, давал баллы и
 * тревогу по вопросу, которого по методике не задавали. Теперь проверяется,
 * считается и записывается одно и то же множество.
 *
 * Ответ на неизвестный вопрос выпадает молча: его и раньше не записывали и
 * не считали. Два ответа на один вопрос — берётся последний, как берёт
 * Map во всех остальных местах движка (сервер такую сдачу отвергает раньше).
 */
export function countedAnswers(
  survey: Pick<SurveyFull, "questions">,
  answers: Answer[],
): { answers: Answer[]; hidden: string[] } {
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const counted: Answer[] = [];
  const hidden: string[] = [];
  for (const question of survey.questions) {
    const answer = byQuestion.get(question.id);
    if (!answer) continue;
    if (isQuestionVisible(question, survey.questions, byQuestion)) counted.push(answer);
    else hidden.push(question.id);
  }
  return { answers: counted, hidden };
}

/**
 * Критические ответы — без учёта видимости, как есть.
 *
 * Кирпич, а не вход: сдачу оценивает evaluateSubmission. Отдельно нужен
 * черновику (сервер поднимает тревогу при автосохранении, не дожидаясь
 * сдачи) и тестам эталонных методик.
 */
export function detectAnswerRisks(survey: Pick<SurveyFull, "questions">, answers: Answer[]): AnswerRisk[] {
  const byQuestion = new Map(answers.map((a) => [a.questionId, a]));
  const found: AnswerRisk[] = [];
  for (const question of survey.questions) {
    const answer = byQuestion.get(question.id);
    if (!answer || answer.skipped) continue;
    const risk = answerRiskOf(question, answer);
    if (risk) found.push({ questionId: question.id, ...risk });
  }
  return found;
}

function answerRiskOf(question: Question, answer: Answer): { label: string; severity: RiskSeverity } | null {
  /*
   * Выбранный вариант помечен как критический — берём САМЫЙ ТЯЖЁЛЫЙ из
   * отмеченных, а не первый попавшийся.
   *
   * Прежний цикл выходил на первом совпадении, то есть на том варианте,
   * который стоит раньше по порядку. В вопросе с выбором нескольких —
   * «мысли о смерти» (умеренная) и «план ухода из жизни» (тяжёлая) —
   * человек, отметивший оба, поднимал тревогу как умеренную. Случай
   * открывался умеренным, и в очереди разбора оказывался ниже.
   *
   * Ответ матрицы — такой же выбор варианта, только по строке: критический
   * столбец в любой строке — критический ответ.
   */
  const picked = new Set([...(answer.optionIds ?? []), ...Object.values(answer.matrix ?? {})]);
  let worst: { label: string; severity: RiskSeverity } | null = null;
  for (const option of question.options) {
    if (!option.riskFlag || !picked.has(option.id)) continue;
    const found = {
      label: option.riskLabel ?? `${question.title} — ${option.text}`,
      severity: option.riskSeverity ?? ("severe" as RiskSeverity),
    };
    if (!worst || WEIGHT[found.severity] > WEIGHT[worst.severity]) worst = found;
  }
  if (worst) return worst;

  // числовой ответ достиг порога
  if (question.riskThreshold !== null && question.riskThreshold !== undefined && typeof answer.number === "number") {
    if (answer.number >= question.riskThreshold) {
      return {
        label: question.riskLabel ?? `${question.title}: ${answer.number}`,
        severity: question.riskSeverity ?? "severe",
      };
    }
  }
  return null;
}

/**
 * Сигналы по полосам шкал.
 *
 * Тревогу долго поднимал только вариант ответа с riskFlag. У МЛО
 * «Адаптивність-200» — основной методики учреждения — таких вариантов нет ни
 * одного: её суицидальный риск выражен полосой стенов, и полоса «вкрай
 * низький рівень» не поднимала ни тревоги, ни случая. То же у PHQ-9: 27
 * баллов из 27 при ответе «жодного разу» на девятый пункт не давали ничего.
 *
 * Берутся только содержательные шкалы: полоса шкалы достоверности говорит о
 * качестве протокола, а не о состоянии человека, и звать по ней специалиста
 * незачем. Ненормированный балл пропускается: полосы заданы в единицах
 * нормировки, движок такой полосы не назначает — но проверить это здесь
 * дешевле, чем однажды получить тревогу по сырому баллу, случайно попавшему
 * в диапазон стенов.
 */
export function detectBandRisks(scores: ScoreResult[]): BandRisk[] {
  const found: BandRisk[] = [];
  for (const score of scores) {
    if (score.kind !== "clinical" || !score.normalized) continue;
    const severity = score.band?.severity;
    if (severity !== "moderate" && severity !== "severe") continue;
    found.push({
      scaleId: score.scaleId,
      label: `${score.scaleTitle}: ${score.band?.label ?? ""}`.trim(),
      severity,
    });
  }
  return found;
}

/**
 * Итоговый риск по ответам и уже посчитанным баллам.
 *
 * Ответы проходят тот же отбор видимых, что и в evaluateSubmission: риск по
 * скрытому пункту не поднимается, откуда бы ни позвали.
 */
export function assessRisk(
  survey: Pick<SurveyFull, "questions">,
  answers: Answer[],
  scores: ScoreResult[],
): SubmissionRisk {
  const answerRisks = detectAnswerRisks(survey, countedAnswers(survey, answers).answers);
  const bandRisks = detectBandRisks(scores);
  let severity: RiskSeverity | null = null;
  for (const r of [...answerRisks, ...bandRisks]) severity = worse(severity, r.severity);
  return { answers: answerRisks, bands: bandRisks, severity };
}

/**
 * Сдача целиком: отбор ответов, профиль и риск — один вход для сервера и клиентов.
 *
 * Сервер зовёт её перед записью (apps/api/src/lib/submission.ts), мобилка и
 * веб-кабинет — когда сдача ушла в офлайн-очередь. Разойтись им не в чем: у
 * них один и тот же код.
 */
export function evaluateSubmission(
  survey: SurveyFull,
  answers: Answer[],
  respondent: RespondentContext = { sex: null, age: null },
): SubmissionEvaluation {
  const counted = countedAnswers(survey, answers);
  const profile: ProfileResult = survey.scoringEnabled
    ? computeProfile(survey, counted.answers, respondent)
    : { scores: [], reliable: true, warnings: [] };
  return {
    answers: counted.answers,
    hidden: counted.hidden,
    profile,
    risk: assessRisk(survey, counted.answers, profile.scores),
  };
}
