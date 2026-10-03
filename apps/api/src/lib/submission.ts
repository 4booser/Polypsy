import {
  ageAt,
  ageBandOf,
  answerScore,
  evaluateSubmission,
  isAnswered,
  isQuestionVisible,
  type Answer,
  type Lang,
  type ProfileResult,
  type Question,
  type ScoreResult,
  type SubmissionRisk,
  type SubmitResponseInput,
  type SurveyFull,
} from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { and, eq } from "drizzle-orm";
import {
  answerEvents,
  answers,
  responseScores,
  responses,
  riskAlerts,
  surveyAccess,
  surveyVersions,
  type UserRow,
} from "../db/schema";
import { badRequest, conflict } from "./http";
import { decryptField, encryptField } from "./crypto";
import { responseSource } from "./responseSource";
import { attachToCase } from "./alertCases";
import { applyRules } from "./decisions";
import { publish } from "./events";
import { log } from "./log";
import { assertAttemptsLeft, consumeAttempt } from "./attempts";
import { assertBatteryOrder, closeCompletedBatteries, holdCompletable } from "./batteries";
import { runCascades, type CascadeOutcome } from "./cascade";
import { env } from "../env";

/**
 * Ядро сохранения прохождения — общее для обычной сдачи и киоска.
 *
 * Порядок фиксирован: проверка формы ответов → проверка очерёдности батареи →
 * подсчёт профиля по паспортной части → одна транзакция на прохождение,
 * ответы, события, баллы и тревоги. Никаких обращений к журналу здесь нет:
 * запись в журнал остаётся на маршруте — там известен актор и контекст.
 */

/**
 * Каждый ответ — на пункт той версии, по которой его пишут, или отказ.
 *
 * Волна 16, внешний разбор, P1. Каждая версия методики заводит пункты с
 * новыми идентификаторами, а автосохранение и сдача ответ на чужой пункт
 * молча пропускали: запись шла по версии, пункта в ней нет — строка не
 * ложилась. Мобилка после обновления методики открывала новую версию и
 * восстанавливала ответы черновика старой; автосохранение отвечало 200 с
 * «answers: 1», а следующее чтение черновика было пустым. На сдаче та же
 * пара давала прохождение без единого ответа, если в новой версии нет
 * обязательных пунктов, — «пройдено» с баллами, которых человек не давал.
 *
 * Отказ — 409, а не 400: запрос собран верно, не сходится состояние —
 * ответы набраны на одной версии, а пишутся в другую. Фраза говорит, что
 * ничего не записано, и что делать: открыть методику заново — клиент
 * откроет её в версии черновика. Правило одно на все входы: черновик
 * (routes/responses.ts), сдача и всё, что идёт через persistSubmission.
 *
 * Скрытые условием показа пункты сюда не относятся: они в версии есть, их
 * ответы отбрасывает движок подсчёта и считает журнал сдачи (hiddenDropped).
 */
export function assertAnswersInVersion(survey: SurveyFull, answers: readonly { questionId: string }[]): void {
  const own = new Set(survey.questions.map((q) => q.id));
  const foreign = answers.filter((a) => !own.has(a.questionId)).map((a) => a.questionId);
  if (!foreign.length) return;
  // идентификаторы пунктов — не сведения о человеке; по ним видно, какой клиент собирает такие пары
  log.warn("answers.other_version", { surveyId: survey.id, versionId: survey.versionId, count: foreign.length, questionIds: foreign.slice(0, 20) });
  conflict("err.answersOtherVersion");
}

export function validateAnswers(survey: SurveyFull, input: SubmitResponseInput): Map<string, Answer> {
  assertAnswersInVersion(survey, input.answers);
  /*
   * Один ответ на вопрос.
   *
   * Карта ниже оставляет последний из повторов, и проверялся только он — а
   * записывались все: первый, непроверенный, ложился в ответы прохождения
   * рядом со вторым. Такой сдачи честный клиент не собирает, и принимать её
   * не за что.
   */
  const seen = new Set<string>();
  for (const a of input.answers) {
    if (seen.has(a.questionId)) {
      const title = survey.questions.find((q) => q.id === a.questionId)?.title ?? a.questionId;
      badRequest("err.duplicateAnswer", { title });
    }
    seen.add(a.questionId);
  }

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
  /**
   * Сколько сигналов риска дала сдача — критические ответы и полосы шкал.
   * До волны 12 считались только ответы; что показать, решается по `risk`.
   */
  risksTriggered: number;
  /**
   * Итоговый риск сдачи — тот самый, по которому подняты тревоги и
   * проверены правила (packages/shared/src/risk.ts). Кризисная карточка
   * берёт его же: три решения по одному прохождению не расходятся.
   */
  risk: SubmissionRisk;
  /**
   * Вопросы, ответы на которые пришли, но вопрос скрыт условием показа:
   * такие ответы не считались и не записаны. Для журнала сдачи.
   */
  hiddenDropped: string[];
  /** Что назначила автоматика по интерпретационным полосам */
  cascade: CascadeOutcome;
}

export async function persistSubmission(
  survey: SurveyFull,
  subject: Pick<UserRow, "id" | "sex" | "birthDate">,
  input: SubmitResponseInput,
  options: { filledBySelf: boolean; lang?: Lang; source?: ResponseSource },
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
  await assertBatteryOrder(subject.id, survey.id, options.filledBySelf, options.lang);

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
  /*
   * Быстрая проверка до всей работы — чтобы отказать понятной ошибкой, не
   * считая профиль. Настоящее списание идёт внутри транзакции ниже: только
   * там его нельзя обойти двумя одновременными отправками.
   */
  if (linkedUserId && options.filledBySelf) {
    await assertAttemptsLeft(linkedUserId, survey.id);
  }

  const submittedAt = await completionTime(survey, linkedUserId, input);
  const respondent = {
    sex: subject.sex,
    // возраст — на момент ответов, а не отправки: нормы стратифицированы по возрасту
    age: ageAt(decryptField(subject.birthDate), submittedAt, env.institutionTz),
  };
  // снэпшоты стратификации на момент сдачи: профиль меняется, история — нет;
  // и это единственный путь SQL-группировки при шифрованной дате рождения
  const ageBand = ageBandOf(respondent.age);
  /*
   * Отбор ответов, профиль и риск — одним вызовом общего движка, тем же, что
   * у клиентов без сети (packages/shared/src/risk.ts). Здесь больше не
   * решается ни что считать, ни что считать риском: иначе сервер и
   * устройство снова разошлись бы, а разошлись они ровно на кризисной
   * карточке.
   *
   * Скрытые условием ответы отбрасываются до подсчёта, записи и поиска
   * риска — проверка выше их пропускает, значит, и считать их не за что.
   */
  const evaluation = evaluateSubmission(survey, input.answers as Answer[], respondent);
  const profile: ProfileResult = evaluation.profile;
  const scores = profile.scores;
  const risk = evaluation.risk;
  const counted = evaluation.answers;
  const responseId = crypto.randomUUID();
  const validIds = new Set(survey.questions.map((q) => q.id));
  const questionById = new Map(survey.questions.map((q) => [q.id, q]));

  if (evaluation.hidden.length) {
    // идентификаторы пунктов — не сведения о человеке; число и какие — для разбора клиента
    log.warn("submission.hidden_answers_dropped", {
      surveyId: survey.id,
      versionId: survey.versionId,
      count: evaluation.hidden.length,
      questionIds: evaluation.hidden,
    });
  }

  /*
   * Назначения наборов, которые эта сдача может завершить, — под замок
   * строки ДО первой записи (списания попытки). Иначе две последние
   * методики набора, сданные одновременно, не видят друг друга и оставляют
   * назначение открытым навсегда; почему именно до записи — см.
   * lib/batteries.ts, holdCompletable. Под системной ролью, как и само
   * закрытие ниже: строку назначения пациент не пишет.
   */
  const completable = await asSystem(() => holdCompletable(subject.id, survey.id));

  await db.transaction(async (tx) => {
    if (linkedUserId && options.filledBySelf) {
      const left = await consumeAttempt(tx as never, linkedUserId, survey.id);
      if (!left) badRequest("err.attemptsSpent");
    }

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
       * Достоверность фиксируется вместе с прохождением, а не выводится
       * потом: она зависит от норм и от пола, известных в этот момент.
       */
      reliable: profile.reliable,
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

    /*
     * Тревоги — по итоговому риску сдачи: критические ответы (они есть и у
     * методики без подсчёта) и полосы содержательных шкал. Список сигналов
     * решён движком (packages/shared/src/risk.ts, detectBandRisks — почему
     * полоса тоже сигнал и почему только содержательной шкалы); здесь он
     * только записывается.
     */
    const riskAt = new Date().toISOString();
    const signals = [
      ...risk.answers.map((r) => ({ questionId: r.questionId, scaleId: null, label: r.label, severity: r.severity })),
      ...risk.bands.map((r) => ({ questionId: null, scaleId: r.scaleId, label: r.label, severity: r.severity })),
    ];
    for (const signal of signals) {
      // случай открывается один на человека: разбирают не пункты, а человека
      const caseId = await attachToCase(tx as never, {
        userId: linkedUserId,
        surveyId: survey.id,
        severity: signal.severity,
        at: riskAt,
      });
      await tx
        .insert(riskAlerts)
        .values({
          id: crypto.randomUUID(),
          responseId,
          surveyId: survey.id,
          questionId: signal.questionId,
          scaleId: signal.scaleId,
          userId: linkedUserId,
          caseId,
          label: signal.label,
          severity: signal.severity,
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
        severity: signal.severity,
        at: riskAt,
      });
    }

    // записываются те же ответы, что посчитаны: скрытый условием пункт не
    // должен всплыть в карте, в разборе пунктов и в аналитике по пунктам
    for (const answer of counted) {
      const question = questionById.get(answer.questionId);
      if (!question) continue;
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
        normalized: score.normalized,
        bandLabel: score.band?.label ?? null,
        severity: score.band?.severity ?? null,
      });
    }
  });

  /*
   * Всё ниже — автоматика поверх прохождения, а не действие человека, и
   * идёт под системной ролью в той же транзакции (см. asSystem): правила и
   * каскады читают настройки групп, которых пациент не видит, и пишут в
   * таблицы, которые ему закрыты. Сам случай тревоги переключается внутри
   * attachToCase — у него есть и другие вызывающие.
   */
  await asSystem(() => closeCompletedBatteries(completable));

  // каскады и протоколы наблюдения — после закрытия батарей: иначе каскадное
  // назначение могло бы закрыться тем же проходом, которым было создано
  const cascade = await asSystem(() => runCascades(survey.id, linkedUserId, scores));

  /*
   * Правила поддержки решений — после каскадов: каскад назначает методики по
   * жёсткой настройке самой методики, правило же только предлагает, и
   * предлагать разумнее с учётом уже назначенного.
   */
  await asSystem(() =>
    applyRules({
      responseId,
      surveyId: survey.id,
      userId: linkedUserId,
      scores,
      /*
       * Тот же итоговый риск, что поднял тревоги. Здесь стояла тяжесть одних
       * критических ответов: тяжёлая полоса шкалы открывала случай в очереди
       * дежурного, а правило «тяжёлый риск» по тому же прохождению молчало.
       */
      riskSeverity: risk.severity,
    }),
  );

  return {
    responseId,
    submittedAt,
    scores,
    profile,
    risksTriggered: risk.answers.length + risk.bands.length,
    risk,
    hiddenDropped: evaluation.hidden,
    cascade,
  };
}

/**
 * Когда человек закончил отвечать — этим моментом и датируется прохождение.
 *
 * Сдача из офлайн-очереди доходит через часы и дни, и датировалась она
 * моментом синхронизации: замер, сделанный в понедельник, ложился в
 * динамику средой, а возраст для норм считался на среду — у человека,
 * которому между ними исполнилось 18 или 60, это другая страта норм, то
 * есть другой T-балл (клиническое ревью, волна 12). Клиент момент знает:
 * начало (startedAt) и длительность (durationMs) он присылает всегда.
 *
 * Принимается он в разумных пределах, а не на веру: время устройства бывает
 * сбито, а дата сдачи — клинический факт. Не из будущего; не раньше, чем
 * появилась версия методики, которую человек проходил; не раньше
 * назначения этой методики этому человеку, если оно есть. Вне пределов —
 * время приёма сервером, как было до правки, со строкой в журнале: сбитые
 * часы видно, а не угадывается.
 *
 * Время тревоги этим не сдвигается: случай в очереди дежурного датируется
 * тем, когда сигнал пришёл (см. riskAt ниже), — «сколько минут висит»
 * считается от него, а не от прошлого понедельника.
 */
async function completionTime(
  survey: SurveyFull,
  userId: string | null,
  input: SubmitResponseInput,
): Promise<string> {
  const now = Date.now();
  const claimed = Date.parse(input.startedAt) + input.durationMs;
  if (!Number.isFinite(claimed)) return new Date(now).toISOString();

  const [version] = survey.versionId
    ? await db
        .select({ createdAt: surveyVersions.createdAt })
        .from(surveyVersions)
        .where(eq(surveyVersions.id, survey.versionId))
    : [];
  const [grant] = userId
    ? await db
        .select({ grantedAt: surveyAccess.grantedAt })
        .from(surveyAccess)
        .where(and(eq(surveyAccess.surveyId, survey.id), eq(surveyAccess.userId, userId)))
    : [];
  const floor = Math.max(
    version ? Date.parse(version.createdAt) : Number.NEGATIVE_INFINITY,
    grant ? Date.parse(grant.grantedAt) : Number.NEGATIVE_INFINITY,
  );

  // запас на расхождение часов устройства и сервера: минута — не «из будущего»
  const SKEW_MS = 60_000;
  if (claimed > now + SKEW_MS || claimed < floor - SKEW_MS) {
    // info, а не warn: посев демо-данных (demoFill) датирует сдачи прошлым нарочно и упирается сюда на каждой
    log.info("submission.completion_time_rejected", {
      surveyId: survey.id,
      claimed: new Date(claimed).toISOString(),
      reason: claimed > now ? "future" : "before_version_or_assignment",
    });
    return new Date(now).toISOString();
  }
  return new Date(Math.min(claimed, now)).toISOString();
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
    case "multiple": {
      /*
       * Каждый вариант — не больше одного раза. Проверялась только
       * принадлежность вопросу, и три одинаковых id при максимуме 3 давали
       * балл 9 (воспроизведено). Движок теперь и сам считает вариант один
       * раз, но такую сдачу честный клиент не собирает — отказ, а не
       * молчаливая правка чужих данных.
       */
      const ids = answer.optionIds ?? [];
      if (new Set(ids).size !== ids.length) badRequest("err.optionDuplicates", { title: question.title });
      for (const id of ids) {
        if (!optionIds.has(id)) badRequest("err.invalidOption", { title: question.title });
      }
      break;
    }

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
