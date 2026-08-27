import {
  ageAt,
  ageBandOf,
  answerScore,
  computeProfile,
  isAnswered,
  isQuestionVisible,
  type Answer,
  type ProfileResult,
  type Question,
  type ScoreResult,
  type SubmitResponseInput,
  type SurveyFull,
} from "@quizzy/shared";
import { db } from "../db";
import { answerEvents, answers, responseScores, responses, riskAlerts, type UserRow } from "../db/schema";
import { badRequest } from "./http";
import { decryptField, encryptField } from "./crypto";
import { detectRisks } from "./risk";
import { assertBatteryOrder, closeCompletedBatteries } from "./batteries";
import { runCascades, type CascadeOutcome } from "./cascade";

/**
 * Ядро сохранения прохождения — общее для обычной сдачи и киоска.
 *
 * Порядок фиксирован: проверка формы ответов → проверка очерёдности батареи →
 * подсчёт профиля по паспортной части → одна транзакция на прохождение,
 * ответы, события, баллы и тревоги. Никаких обращений к журналу здесь нет:
 * запись в журнал остаётся на маршруте — там известен актор и контекст.
 */

export function validateAnswers(survey: SurveyFull, input: SubmitResponseInput): Map<string, Answer> {
  const answerMap = new Map(input.answers.map((a) => [a.questionId, a as Answer]));

  for (const question of survey.questions) {
    if (question.type === "info") continue;
    if (!isQuestionVisible(question, survey.questions, answerMap)) continue;

    const answer = answerMap.get(question.id);
    // сначала форма ответа, потом обязательность: битый ответ не должен
    // маскироваться сообщением «не отвечен обязательный вопрос»
    if (answer) validateAnswerShape(question, answer);
    if (question.required && !isAnswered(question, answer)) {
      badRequest(`Не отвечен обязательный вопрос: ${question.title}`);
    }
  }
  return answerMap;
}

export interface PersistResult {
  responseId: string;
  submittedAt: string;
  scores: ScoreResult[];
  profile: ProfileResult;
  /** Сработали критические пункты — вызывающий решает, что показать */
  risksTriggered: number;
  /** Что назначила автоматика по интерпретационным полосам */
  cascade: CascadeOutcome;
}

export async function persistSubmission(
  survey: SurveyFull,
  subject: Pick<UserRow, "id" | "sex" | "birthDate">,
  input: SubmitResponseInput,
  options: { filledBySelf: boolean; lang?: "uk" | "ru" },
): Promise<PersistResult> {
  validateAnswers(survey, input);

  // очерёдность внутри батареи проверяем до записи: отказ после сохранения
  // означал бы прохождение, которого не должно было быть
  await assertBatteryOrder(subject.id, survey.id, options.filledBySelf);

  const respondent = {
    sex: subject.sex,
    age: ageAt(decryptField(subject.birthDate), new Date().toISOString()),
  };
  // снэпшоты стратификации на момент сдачи: профиль меняется, история — нет;
  // и это единственный путь SQL-группировки при шифрованной дате рождения
  const ageBand = ageBandOf(respondent.age);
  const profile: ProfileResult = survey.scoringEnabled
    ? computeProfile(survey, input.answers as Answer[], respondent)
    : { scores: [], reliable: true, warnings: [] };
  const scores = profile.scores;
  const responseId = crypto.randomUUID();
  const submittedAt = new Date().toISOString();
  const validIds = new Set(survey.questions.map((q) => q.id));

  const risks = detectRisks(survey, input.answers as Answer[]);

  await db.transaction(async (tx) => {
    await tx.insert(responses).values({
      id: responseId,
      surveyId: survey.id,
      // прохождение принадлежит обследуемому, а не тому, кто внёс данные
      userId: survey.anonymous ? null : subject.id,
      status: input.status,
      versionId: survey.versionId,
      startedAt: input.startedAt,
      submittedAt,
      durationMs: input.durationMs,
      clientRequestId: input.clientRequestId ?? null,
      respondentSex: survey.anonymous ? null : subject.sex,
      respondentAgeBand: survey.anonymous ? null : ageBand,
      lang: options.lang ?? null,
    });

    // тревоги — до подсчёта: они не зависят от шкал и должны сработать даже
    // у методики без подсчёта
    for (const risk of risks) {
      await tx
        .insert(riskAlerts)
        .values({
          id: crypto.randomUUID(),
          responseId,
          surveyId: survey.id,
          questionId: risk.questionId,
          userId: survey.anonymous ? null : subject.id,
          label: risk.label,
          severity: risk.severity,
          at: new Date().toISOString(),
        })
        .onConflictDoNothing();
    }

    for (const answer of input.answers) {
      if (!validIds.has(answer.questionId)) continue;
      const question = survey.questions.find((q) => q.id === answer.questionId)!;
      await tx.insert(answers).values({
        id: crypto.randomUUID(),
        responseId,
        questionId: answer.questionId,
        optionIds: answer.optionIds ?? null,
        text: encryptField(answer.text ?? null),
        number: answer.number ?? null,
        date: answer.date ?? null,
        matrix: answer.matrix ?? null,
        ranking: answer.ranking ?? null,
        skipped: answer.skipped ?? false,
        score: survey.scoringEnabled ? answerScore(question, answer as Answer) : null,
        durationMs: answer.durationMs ?? 0,
        changeCount: answer.changeCount ?? 0,
        visitCount: answer.visitCount ?? 1,
      });
    }

    // лента событий — в той же транзакции: прохождение либо целиком, либо никак
    for (const event of input.events) {
      if (!validIds.has(event.questionId)) continue;
      await tx.insert(answerEvents).values({
        id: crypto.randomUUID(),
        responseId,
        questionId: event.questionId,
        sequence: event.sequence,
        kind: event.kind,
        elapsedMs: event.elapsedMs,
        at: event.at,
        value: event.value ?? null,
      });
    }

    for (const score of scores) {
      await tx.insert(responseScores).values({
        id: crypto.randomUUID(),
        responseId,
        scaleId: score.scaleId,
        rawScore: score.rawScore,
        value: score.value,
        normalization: score.normalization,
        maxScore: score.maxScore,
        percent: score.percent,
        bandLabel: score.band?.label ?? null,
        severity: score.band?.severity ?? null,
      });
    }
  });

  await closeCompletedBatteries(subject.id, survey.id);

  // каскады и протоколы наблюдения — после закрытия батарей: иначе каскадное
  // назначение могло бы закрыться тем же проходом, которым было создано
  const cascade = await runCascades(survey.id, survey.anonymous ? null : subject.id, scores);

  return {
    responseId,
    submittedAt,
    scores,
    profile,
    risksTriggered: risks.length,
    cascade,
  };
}

function validateAnswerShape(question: Question, answer: Answer): void {
  const optionIds = new Set(question.options.filter((o) => o.kind === "option").map((o) => o.id));
  const rowIds = new Set(question.options.filter((o) => o.kind === "row").map((o) => o.id));

  switch (question.type) {
    case "single":
    case "yesno":
      if ((answer.optionIds?.length ?? 0) > 1) {
        badRequest(`Можно выбрать только один вариант: ${question.title}`);
      }
    // fallthrough — проверка принадлежности вариантов общая
    case "multiple":
      for (const id of answer.optionIds ?? []) {
        if (!optionIds.has(id)) badRequest(`Недопустимый вариант ответа: ${question.title}`);
      }
      break;

    case "matrix":
      for (const [rowId, optionId] of Object.entries(answer.matrix ?? {})) {
        if (!rowIds.has(rowId)) badRequest(`Недопустимая строка матрицы: ${question.title}`);
        if (!optionIds.has(optionId)) badRequest(`Недопустимый вариант в матрице: ${question.title}`);
      }
      break;

    case "ranking": {
      const ranking = answer.ranking ?? [];
      if (new Set(ranking).size !== ranking.length) {
        badRequest(`В ранжировании есть повторы: ${question.title}`);
      }
      for (const id of ranking) {
        if (!optionIds.has(id)) badRequest(`Недопустимый вариант в ранжировании: ${question.title}`);
      }
      break;
    }

    case "scale":
    case "slider":
    case "number": {
      if (answer.number === undefined) break;
      const min = question.minValue ?? 0;
      const max = question.maxValue ?? 100;
      if (answer.number < min || answer.number > max) {
        badRequest(`Значение вне диапазона ${min}–${max}: ${question.title}`);
      }
      break;
    }

    case "date":
      if (answer.date && Number.isNaN(Date.parse(answer.date))) {
        badRequest(`Некорректная дата: ${question.title}`);
      }
      break;

    default:
      break;
  }
}
