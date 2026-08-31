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
import { responseSource } from "./responseSource";
import { attachToCase } from "./alertCases";
import { applyRules } from "./decisions";
import { publish } from "./events";
import { detectRisks } from "./risk";
import { assertAttemptsLeft } from "./attempts";
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
      badRequest("err.requiredUnanswered", { title: question.title });
    }
  }
  return answerMap;
}

/** Откуда взялось прохождение — см. lib/responseSource */
export type ResponseSource = "assigned" | "self" | "kiosk" | "clinician" | "informant" | "intake";

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
  options: { filledBySelf: boolean; lang?: "uk" | "ru"; source?: ResponseSource },
): Promise<PersistResult> {
  validateAnswers(survey, input);

  /*
   * Кого записываем в прохождение.
   *
   * Анонимная методика не связывается с человеком по определению. Форма
   * информанта — тоже, но по другой причине: её заполняет посторонний человек
   * О пациенте, и записать её на пациента значило бы смешать взгляд со
   * стороны с его самоотчётом в каждом графике, каждом RCI и каждой выборке
   * норм. Связь с пациентом живёт отдельно, в informant_requests, и её видит
   * только тот код, который для этого написан.
   *
   * Решение принимается один раз здесь, а не повторяется у каждой вставки:
   * повторённое семь раз условие — это семь мест, где новый случай забудут.
   */
  const linkedUserId =
    survey.anonymous || survey.administration === "informant" ? null : subject.id;

  // очерёдность внутри батареи проверяем до записи: отказ после сохранения
  // означал бы прохождение, которого не должно было быть
  await assertBatteryOrder(subject.id, survey.id, options.filledBySelf);

  /*
   * Число попыток по назначению — тоже до записи.
   *
   * Проверяется только там, где есть назначение: у методики, которую человек
   * проходит сам, попыток никто не выдавал, и ограничивать нечего. Иначе
   * ограничение из назначения молча распространилось бы на общедоступные
   * методики, которых оно не касается.
   *
   * Без этой проверки число попыток было бы украшением карточки: оно
   * показывалось бы специалисту и ничего не значило.
   */
  if (linkedUserId && options.filledBySelf) {
    await assertAttemptsLeft(linkedUserId, survey.id);
  }

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
      userId: linkedUserId,
      status: input.status,
      versionId: survey.versionId,
      startedAt: input.startedAt,
      submittedAt,
      durationMs: input.durationMs,
      clientRequestId: input.clientRequestId ?? null,
      respondentSex: linkedUserId ? subject.sex : null,
      respondentAgeBand: linkedUserId ? ageBand : null,
      lang: options.lang ?? null,
      /*
       * Источник выводится сервером, а не приходит с клиентом: клиент мог бы
       * объявить своё прохождение назначенным, и «самообращение» — само по
       * себе сведение о человеке — растворилось бы среди плановых замеров.
       *
       * Публичные конвейеры (киоск, форма информанта) называют источник
       * прямо: там нет учётной записи, по которой его можно вывести.
       */
      source:
        options.source ??
        (linkedUserId ? await responseSource(linkedUserId, survey.id, input.onBehalfOf ?? null) : null),
    });

    // тревоги — до подсчёта: они не зависят от шкал и должны сработать даже
    // у методики без подсчёта
    const riskAt = new Date().toISOString();
    for (const risk of risks) {
      // случай открывается один на человека: разбирают не пункты, а человека
      const caseId = await attachToCase(tx as never, {
        userId: linkedUserId,
        surveyId: survey.id,
        severity: risk.severity,
        at: riskAt,
      });
      await tx
        .insert(riskAlerts)
        .values({
          id: crypto.randomUUID(),
          responseId,
          surveyId: survey.id,
          questionId: risk.questionId,
          userId: linkedUserId,
          caseId,
          label: risk.label,
          severity: risk.severity,
          at: riskAt,
        })
        .onConflictDoNothing();

      /*
       * Уведомление уходит в той же транзакции: `pg_notify` доставляется
       * только при коммите, поэтому «сообщили дежурному, а запись
       * откатилась» невозможно по устройству, а не по внимательности.
       */
      await publish(tx as never, {
        kind: "alert.created",
        surveyIds: [survey.id],
        userId: linkedUserId,
        severity: risk.severity,
        at: riskAt,
      });
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
  const cascade = await runCascades(survey.id, linkedUserId, scores);

  /*
   * Правила поддержки решений — после каскадов: каскад назначает методики по
   * жёсткой настройке самой методики, правило же только предлагает, и
   * предлагать разумнее с учётом уже назначенного.
   */
  await applyRules({
    responseId,
    surveyId: survey.id,
    userId: linkedUserId,
    scores,
    riskSeverity: risks.length
      ? (risks.some((r) => r.severity === "severe") ? "severe" : "moderate")
      : null,
  });

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
    // Проход дальше намеренный: после проверки «выбран один вариант» идёт
    // общая для всех выборов проверка принадлежности вариантов вопросу.
    // biome-ignore lint/suspicious/noFallthroughSwitchClause: см. выше
    case "yesno":
      if ((answer.optionIds?.length ?? 0) > 1) {
        badRequest("err.singleChoiceOnly", { title: question.title });
      }
    case "multiple":
      for (const id of answer.optionIds ?? []) {
        if (!optionIds.has(id)) badRequest("err.invalidOption", { title: question.title });
      }
      break;

    case "matrix":
      for (const [rowId, optionId] of Object.entries(answer.matrix ?? {})) {
        if (!rowIds.has(rowId)) badRequest("err.invalidMatrixRow", { title: question.title });
        if (!optionIds.has(optionId)) badRequest("err.invalidMatrixOption", { title: question.title });
      }
      break;

    case "ranking": {
      const ranking = answer.ranking ?? [];
      if (new Set(ranking).size !== ranking.length) {
        badRequest("err.rankingDuplicates", { title: question.title });
      }
      for (const id of ranking) {
        if (!optionIds.has(id)) badRequest("err.invalidRankingOption", { title: question.title });
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
        badRequest("err.valueOutOfRange", { min, max, title: question.title });
      }
      break;
    }

    case "date":
      if (answer.date && Number.isNaN(Date.parse(answer.date))) {
        badRequest("err.invalidDate", { title: question.title });
      }
      break;

    default:
      break;
  }
}
