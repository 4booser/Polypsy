import { bandFor, renderCoded, t } from "@quizzy/shared";
import { Hono, type Context } from "hono";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  submitResponseSchema,
  type Answer,
  type ResponseDetailBand,
  type ScoreResult,
  type SurveyFull,
  type SurveyResponse,
  type User,
} from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import {
  answerEvents,
  answers,
  auditLog,
  questions,
  referrals,
  riskAlerts,
  responseScores,
  responses,
  scales,
  surveyVersions,
  surveys,
  users,
} from "../db/schema";
import { attachToCase } from "../lib/alertCases";
import { badRequest, conflict, forbidden, langOf, notFound, parseBody, parseQuery } from "../lib/http";
import { getSurvey, getSurveyForResponse } from "../lib/surveys";
import { detectRisks } from "../lib/risk";
import { persistSubmission } from "../lib/submission";
import { decryptField, encryptField } from "../lib/crypto";
import { decodeCursor, encodeCursor } from "../lib/cursor";
import { periodFrom, periodTo } from "../lib/population";
import { draftSchema, responseListQuery } from "@quizzy/shared";
import { audit } from "../lib/audit";
import {
  accessiblePatientIds,
  assertPatientAccess,
  assertPatientGroupAccess,
  assertSurveyAccess,
  hasGrant,
  isStaff,
} from "../lib/scope";
import { log } from "../lib/log";
import { hasCurrentConsent } from "../lib/consent";
import { fullNameOf } from "../lib/auth";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const responseRoutes = new Hono<AppEnv>();

responseRoutes.use("*", requireAuth);

/* ─────────── версия прохождения и право его сдать (волна 12, участок submit) ─────────── */

/**
 * Откуда известна версия, по которой считается прохождение.
 *
 *   client   — клиент прислал ту, что показывал (новые клиенты);
 *   inferred — не прислал, но все отвеченные пункты принадлежат одной
 *              версии этой методики: она и была на экране;
 *   current  — не прислал и вывести не из чего (пусто или пункты разных
 *              версий): считаем по действующей, как считали всегда;
 *   invalid  — прислал версию, которой у этой методики нет.
 */
type VersionSource = "client" | "inferred" | "current" | "invalid";

/**
 * Версия методики, которую человек видел, — а не та, что действует сейчас.
 *
 * До волны 12 сервер брал действующую версию. Начатое прохождение ни к
 * чему не было привязано: методику обновили, пока пациент отвечал или пока
 * сдача ждала сети в офлайн-очереди, — и его ответы проверялись по чужим
 * вопросам. Каждая версия заводит пункты с НОВЫМИ идентификаторами, поэтому
 * исход был один из двух, оба плохие: 400 «не отвечен обязательный вопрос»
 * на честно заполненную методику (и, до правки транзакции, потерянный
 * черновик) — или, если обязательных нет, прохождение без единого ответа,
 * посчитанное в нули. Клинический результат, которого человек не давал.
 *
 * Клиент без versionId — решение: ПРИНИМАТЬ. Такие клиенты уже стоят на
 * телефонах, и их офлайн-очередь хранит сдачи, собранные до этой правки;
 * отказ означал бы потерю ответов, которые человек честно дал. Но и
 * «по действующей» вслепую не берём: версия выводится по идентификаторам
 * отвеченных пунктов — они уникальны для версии, и если все они из одной,
 * на экране была именно она. Только если вывести не из чего, считаем по
 * действующей, как раньше. Какой путь сработал — в журнале сдачи
 * (versionSource) и строкой лога: по ней видно, сколько старых клиентов ещё
 * в ходу и когда подпорку можно снимать.
 */
async function pinnedVersion(
  surveyId: string,
  input: { versionId?: string | null; answers: { questionId: string }[] },
): Promise<{ versionId: string | null; source: VersionSource }> {
  if (input.versionId) {
    const [own] = await db
      .select({ id: surveyVersions.id })
      .from(surveyVersions)
      .where(and(eq(surveyVersions.id, input.versionId), eq(surveyVersions.surveyId, surveyId)));
    return own ? { versionId: own.id, source: "client" } : { versionId: null, source: "invalid" };
  }
  const ids = [...new Set(input.answers.map((a) => a.questionId))];
  if (!ids.length) return { versionId: null, source: "current" };
  const found = await db
    .selectDistinct({ versionId: questions.versionId })
    .from(questions)
    .where(and(eq(questions.surveyId, surveyId), inArray(questions.id, ids)));
  return found.length === 1 ? { versionId: found[0]!.versionId, source: "inferred" } : { versionId: null, source: "current" };
}

/**
 * Вправе ли человек сдавать эту методику — теми же правилами, что открывают её.
 *
 * Ограничение доступа проверялось только на чтении (routes/surveys.ts,
 * GET /:id): закрытую методику пациенту отдают при действующем назначении.
 * Сдача и черновик назначения не спрашивали. Пациент, сохранивший вопросы
 * раньше, — открытая вкладка, офлайн-кэш телефона, — мог прислать результат
 * после того, как назначение отозвали или оно истекло, и результат ложился в
 * карту как ни в чём не бывало.
 *
 * Отказ — 403 с причиной, а не 404, как на чтении. Читающему незачем знать,
 * что методика существует; сдающий её уже видел, и «не найдено» на
 * методику, которую он только что заполнял, было бы неправдой. Причина
 * нужна и очереди отправки: отказ по существу разбирает человек, и «строк
 * призначення минув» он поймёт, а «не знайдено» — нет. Отказ — в журнал:
 * сдача после отзыва — ровно то, что стоит найти потом.
 *
 * Сотрудник сдаёт то, с чем вправе работать (assertSurveyAccess) — как и
 * открывает.
 */
async function assertMayTake(c: Context<AppEnv>, user: User, survey: SurveyFull): Promise<void> {
  if (isStaff(user)) {
    await assertSurveyAccess(user, survey.id);
    return;
  }
  if (survey.visibility === "restricted" && !(await hasGrant(user.id, survey.id))) {
    await audit(c, {
      action: "access.denied",
      outcome: "denied",
      resourceType: "survey",
      resourceId: survey.id,
      subjectUserId: user.id,
      details: { method: c.req.method, reason: "survey_grant_missing", path: c.req.path },
    });
    forbidden("err.surveyGrantEnded");
  }
}

/**
 * Информированное согласие — условие приёма ответов, а не только экран.
 *
 * Проверял его один экран приложения: прямой запрос, веб-кабинет (своего
 * экрана согласия у него не было) и офлайн-очередь, досланная после отзыва
 * согласия, сдавали ответы без него (волна 12). Ответы методики — ровно те
 * данные, на обработку которых согласие и берётся, поэтому проверка здесь,
 * на сдаче и черновике.
 *
 * Только для самого пациента. Заполнение за пациента специалистом — работа
 * у койки по согласию, взятому очно, и у многих таких пациентов нет учётной
 * записи, где его можно было бы принять; запереть это значило бы
 * остановить приём. Сотрудник, проходящий методику сам, согласия пациента
 * не даёт.
 */
async function assertConsent(c: Context<AppEnv>, user: User): Promise<void> {
  if (isStaff(user) || (await hasCurrentConsent(user.id))) return;
  await audit(c, {
    action: "access.denied",
    outcome: "denied",
    resourceType: "consent",
    resourceId: user.id,
    subjectUserId: user.id,
    details: { method: c.req.method, reason: "consent_missing", path: c.req.path },
  });
  forbidden("err.consentRequired");
}

/**
 * Пациент в зоне сотрудника — или отказ со строкой журнала.
 *
 * Заполнение за пациента проверяло сотрудника, методику и существование
 * пациента, но не саму зону видимости. А зона считается В ТОМ ЧИСЛЕ по
 * прохождениям методик группы (lib/scope.ts, accessiblePatientIds): знания
 * чужого идентификатора хватало, чтобы вписать человеку клинический
 * результат — и тем самым втянуть его в свою зону, открыв себе карту.
 *
 * Проверка идёт ДО поиска пациента, и отказ один на «нет такого» и «не ваш»:
 * иначе разница 404/403 отвечала бы на вопрос, есть ли в системе человек с
 * этим идентификатором. Суперадмину (зона — все) ищется как прежде.
 */
async function assertMayFillFor(c: Context<AppEnv>, user: User, patientId: string, surveyId: string): Promise<void> {
  const allowed = await accessiblePatientIds(user);
  if (allowed === null || allowed.has(patientId)) return;
  await audit(c, {
    action: "access.denied",
    outcome: "denied",
    resourceType: "user",
    resourceId: patientId,
    subjectUserId: null,
    details: { method: c.req.method, reason: "patient_out_of_scope", surveyId },
  });
  forbidden("err.onBehalfPatientOutOfScope");
}

/**
 * Повтор той же попытки — или чужой идентификатор (волна 12, участок submit).
 *
 * Идемпотентный повтор искал прохождение по одному clientRequestId и
 * отдавал найденное, не спрашивая, чьё оно: баллы, достоверность, план
 * безопасности — любому, кто пришлёт тот же идентификатор. Идентификатор
 * случайный, но он живёт в офлайн-очереди устройства и в логах клиента, и
 * «знать строку» не должно значить «читать чужой результат».
 *
 * Своё — это та же методика и тот же обследуемый; а кто сдавал, если строка
 * этого не говорит (заполнение за пациента, анонимная методика), записано
 * только в журнале сдачи — там его и сверяем.
 */
async function isOwnAttempt(
  existing: typeof responses.$inferSelect,
  surveyId: string,
  user: User,
  onBehalfOf: string | null,
): Promise<boolean> {
  if (existing.surveyId !== surveyId) return false;
  if (existing.userId !== null && existing.userId !== (onBehalfOf ?? user.id)) return false;
  if (!onBehalfOf && existing.userId === user.id) return true;
  // журнал закрыт пациенту политикой строк — сверка идёт системной ролью и отдаёт только «да/нет»
  const [entry] = await asSystem(() =>
    db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "response.submit"), eq(auditLog.resourceId, existing.id), eq(auditLog.actorId, user.id)),
      )
      .limit(1),
  );
  return Boolean(entry);
}

/**
 * Тревоги черновика переезжают на сданное прохождение (волна 12, клиническое
 * ревью).
 *
 * Автосохранение поднимает тревогу раньше сдачи — в этом весь смысл раннего
 * сохранения: дежурный видит критический ответ, пока человек ещё отвечает,
 * и может успеть выписать направление. Сдача же удаляла черновик, а
 * risk_alerts.response_id стоял на каскадном удалении: сигнал исчезал из
 * случая, у направления alertId становился NULL. Теперь внешний ключ не
 * каскадный (миграция 0106), а сигналы черновика перед его удалением
 * переносятся на итоговое прохождение.
 *
 * Если сдача подняла тот же сигнал заново (тот же пункт — в рамках
 * прохождения он один, уникальный индекс), остаётся строка ЧЕРНОВИКА: на
 * неё уже могли сослаться направление, уведомление, отметка «разобрано».
 * Тяжесть берётся большая (понижать нельзя — как и при автосохранении),
 * случай — тот, к которому сигнал привязала сдача: он открыт сейчас, и
 * дежурный работает в нём. Направления, выписанные на черновик, тоже
 * переходят на итоговое прохождение.
 *
 * Системной ролью: строки чужих таблиц (направления, уведомления) пациенту
 * закрыты политиками, а переносит их автоматика поверх его отправки.
 */
async function adoptDraftAlerts(draftIds: string[], finalId: string): Promise<void> {
  const moved = await db.select().from(riskAlerts).where(inArray(riskAlerts.responseId, draftIds));
  await db.update(referrals).set({ responseId: finalId }).where(inArray(referrals.responseId, draftIds));
  if (!moved.length) return;

  const current = await db.select().from(riskAlerts).where(eq(riskAlerts.responseId, finalId));
  const byQuestion = new Map(current.filter((a) => a.questionId).map((a) => [a.questionId!, a]));

  for (const alert of moved.sort((a, b) => a.at.localeCompare(b.at))) {
    const fresh = alert.questionId ? byQuestion.get(alert.questionId) : undefined;
    if (!fresh) {
      await db.update(riskAlerts).set({ responseId: finalId }).where(eq(riskAlerts.id, alert.id));
      if (alert.questionId) byQuestion.set(alert.questionId, { ...alert, responseId: finalId });
      continue;
    }
    const severe = alert.severity === "severe" || fresh.severity === "severe";
    // ссылки на уходящую строку — на остающуюся: направления и уже отправленные уведомления
    await db.update(referrals).set({ alertId: alert.id }).where(eq(referrals.alertId, fresh.id));
    await db.execute(sql`
      update alert_notifications set alert_id = ${alert.id}
       where alert_id = ${fresh.id}
         and kind not in (select kind from alert_notifications where alert_id = ${alert.id})`);
    await db.delete(riskAlerts).where(eq(riskAlerts.id, fresh.id));
    await db
      .update(riskAlerts)
      .set({
        responseId: finalId,
        caseId: fresh.caseId ?? alert.caseId,
        severity: severe ? "severe" : "moderate",
        label: alert.severity === "severe" || fresh.severity !== "severe" ? alert.label : fresh.label,
      })
      .where(eq(riskAlerts.id, alert.id));
    byQuestion.set(alert.questionId!, { ...alert, responseId: finalId });
  }
}

/** Отправка прохождения вместе с телеметрией по каждому вопросу */
responseRoutes.post("/surveys/:id/responses", async (c) => {
  const user = c.get("user");
  const surveyId = c.req.param("id");
  const input = await parseBody(c.req.raw, submitResponseSchema);

  /*
   * Идемпотентный повтор из офлайн-очереди: если попытка с этим id уже
   * закоммичена (сеть оборвалась ПОСЛЕ записи, клиент не узнал), возвращаем
   * существующее прохождение вместо создания дубля.
   */
  if (input.clientRequestId) {
    /*
     * Ищем мимо политик строк: чужая попытка, невидимая пациенту, иначе
     * дошла бы до вставки и упала на уникальном индексе пятисоткой.
     */
    const requestId = input.clientRequestId;
    const existing = await asSystem(() =>
      db.query.responses.findFirst({ where: eq(responses.clientRequestId, requestId) }),
    );
    if (existing && !(await isOwnAttempt(existing, surveyId, user, input.onBehalfOf ?? null))) {
      /*
       * Отказ без подробностей: ни чьё прохождение, ни какой методики — всё
       * это и есть то, чего спрашивающему знать не положено. В журнал —
       * полностью: совпадение чужого идентификатора случайно не бывает.
       */
      await audit(c, {
        action: "access.denied",
        outcome: "denied",
        resourceType: "survey",
        resourceId: surveyId,
        details: { method: c.req.method, reason: "client_request_foreign", responseId: existing.id },
      });
      conflict("err.clientRequestForeign");
    }
    if (existing) {
      /*
       * Повтор отдаёт СОХРАНЁННЫЙ результат, а не пустой.
       *
       * Здесь стояли `scores: []`, `reliable: true` и `safetyPlan: null` —
       * при том, что баллы тут же вычитывались из базы и выбрасывались.
       * Ветка срабатывает на обычном пути мобильного клиента: связь
       * оборвалась после коммита, очередь повторяет ту же попытку.
       *
       * Цена была клинической. План безопасности показывается ровно в момент
       * отправки и больше нигде: человек, у которого сработал критический
       * пункт — суицидальные мысли, — при повторе не видел кризисной
       * карточки вовсе. А `reliable: true` объявляло достоверным протокол,
       * заваливший шкалу лжи.
       */
      const stored = await db
        .select()
        .from(responseScores)
        .where(eq(responseScores.responseId, existing.id));
      const risks = await db
        .select({ id: riskAlerts.id })
        .from(riskAlerts)
        .where(eq(riskAlerts.responseId, existing.id))
        .limit(1);
      const survey = await getSurvey(existing.surveyId, null, langOf(c));
      // повтор отдаёт то же, что первая попытка: баллы — только тем, кому их показывают (resultsShownTo)
      const shown = resultsShownTo(user, survey);

      return c.json(
        {
          id: existing.id,
          surveyId: existing.surveyId,
          submittedAt: existing.submittedAt,
          scores: shown ? stored : [],
          reliable: shown ? existing.reliable : null,
          /*
           * Предупреждений в строке не хранится: они собираются при подсчёте
           * и в базу не попадают. Пустой список здесь — честное «нечего
           * сказать», а не утверждение «замечаний не было»: в отличие от
           * достоверности, предупреждения ни на что не влияют.
           */
          warnings: [],
          safetyPlan:
            risks.length > 0 && existing.userId === user.id ? (survey?.safetyPlan ?? null) : null,
          duplicate: true,
        },
        200,
      );
    }
  }

  /*
   * Содержимое — той версии, которую человек видел (pinnedVersion);
   * статус, архив, видимость и настройки — из строки методики как она есть
   * сейчас: снятую с использования методику не сдают и по старой версии.
   */
  const pin = await pinnedVersion(surveyId, input);
  const survey = await getSurvey(surveyId, pin.versionId, langOf(c));
  if (!survey) notFound("err.surveyNotFound");
  if (survey.status !== "published") badRequest("err.surveyNotAvailableToTake");
  if (survey.archivedAt) badRequest("err.surveyArchived");
  if (survey.administration !== "self" && !isStaff(user)) {
    forbidden("err.staffFillsOnly");
  }

  /*
   * Режим специалиста: клиницист заполняет методику за пациента.
   * Прохождение записывается на пациента, но в журнал уходит, кто его внёс —
   * иначе в карте появлялись бы данные без следа о том, кто их поставил.
   */
  let subjectId = user.id;
  if (input.onBehalfOf) {
    if (!isStaff(user)) forbidden("err.onBehalfStaffOnly");
    await assertSurveyAccess(user, surveyId);
    await assertMayFillFor(c, user, input.onBehalfOf, surveyId);
    const subject = await db.query.users.findFirst({ where: eq(users.id, input.onBehalfOf) });
    if (!subject) notFound("err.patientNotFound");
    if (subject.role !== "user") badRequest("err.onBehalfPatientOnly");
    subjectId = subject.id;
  } else if (survey.administration === "clinician") {
    badRequest("err.onBehalfRequired");
  } else {
    await assertMayTake(c, user, survey);
    await assertConsent(c, user);
  }

  // версию проверяем после прав: иначе ответ «такой версии нет» рассказывал
  // бы о версиях методики тому, кому её не открывали
  if (pin.source === "invalid") badRequest("err.surveyVersionInvalid");
  /*
   * Выведенная версия — обычный путь старого клиента, и считается она верно:
   * это сведение, а не тревога. Предупреждение — только когда вывести было не
   * из чего и посчитали по действующей, как до правки.
   */
  if (pin.source === "inferred") {
    log.info("response.version_inferred", { surveyId, versionId: survey.versionId });
  } else if (pin.source === "current") {
    log.warn("response.version_unpinned", { surveyId, versionId: survey.versionId });
  }

  if (!survey.allowRetake && !survey.anonymous) {
    /*
     * Пара «методика + человек» запирается на время транзакции.
     *
     * Проверка «уже проходил» и запись прохождения идут в одной транзакции
     * (см. db/context), но на READ COMMITTED этого мало: две отправки,
     * ушедшие одновременно — двойное нажатие, повтор из офлайн-очереди без
     * clientRequestId, — обе не видят чужую незакоммиченную строку и обе
     * записываются. В карте оказываются два «единственных» прохождения
     * методики, которую проходят один раз, с разными баллами и разными
     * тревогами; какое из них считать результатом, не решит никто.
     *
     * Замок по хэшу пары, а не на всю таблицу: одновременные отправки
     * разных людей друг друга не касаются. Снимается коммитом вместе с
     * транзакцией запроса, так что проигравший читает уже закоммиченную
     * строку и получает обычный отказ «уже проходили».
     */
    await db.execute(sql`select pg_advisory_xact_lock(hashtext(${`response:${surveyId}:${subjectId}`}))`);
    const existing = await db.query.responses.findFirst({
      where: and(
        eq(responses.surveyId, surveyId),
        eq(responses.userId, subjectId),
        eq(responses.status, "completed"),
      ),
    });
    if (existing) conflict("err.alreadyTaken");
  }

  /*
   * Незавершённый черновик того же человека убирается — иначе он висел бы
   * брошенным прохождением и портил статистику доходимости. Но ПОСЛЕ
   * записи сдачи и после того, как его тревоги переехали на неё (см.
   * adoptDraftAlerts): раньше черновик удалялся первым, и каскад уносил
   * тревоги, поднятые автосохранением, — случай оставался без сигналов, а
   * направление, выписанное по такой тревоге, теряло ссылку на неё.
   */
  const drafts = survey.anonymous
    ? []
    : await db
        .select({ id: responses.id })
        .from(responses)
        .where(
          and(
            eq(responses.surveyId, surveyId),
            eq(responses.userId, subjectId),
            eq(responses.status, "in_progress"),
          ),
        );

  const subject =
    subjectId === user.id
      ? { id: user.id, sex: user.sex, birthDate: user.birthDate }
      : (await db.query.users.findFirst({ where: eq(users.id, subjectId) }))!;

  const persisted = await persistSubmission(
    survey,
    subject,
    input,
    /*
     * Язык прохождения — язык, на котором показали ТЕКСТ, а не язык
     * интерфейса. Поле — психометрический фактор: украинская и русская
     * редакции методики — разные предъявления, и выборки по языку считаются
     * раздельно. При английском интерфейсе пункты украинские (английского
     * текста у методик нет), и записать «en» значило бы завести третью
     * редакцию, которой не существует.
     */
    { filledBySelf: subjectId === user.id, lang: survey.contentLang ?? langOf(c) },
  );
  const { responseId, submittedAt, scores, profile, risk, cascade } = persisted;

  if (drafts.length) {
    const draftIds = drafts.map((d) => d.id);
    await asSystem(() => adoptDraftAlerts(draftIds, responseId));
    await db.delete(responses).where(inArray(responses.id, draftIds));
  }

  await audit(c, {
    action: "response.submit",
    resourceType: "response",
    resourceId: responseId,
    subjectUserId: survey.anonymous ? null : subjectId,
    details: {
      surveyId,
      anonymous: survey.anonymous,
      durationMs: input.durationMs,
      events: input.events.length,
      // кто именно внёс данные, если заполнял специалист
      filledBy: subjectId === user.id ? null : user.email,
      // по какой версии посчитано и откуда она известна — см. pinnedVersion
      versionId: survey.versionId,
      versionSource: pin.source,
      // сколько ответов на скрытые условием пункты движок отбросил до подсчёта
      hiddenDropped: persisted.hiddenDropped.length,
    },
  });

  /*
   * Баллы, полоса, достоверность и предупреждения (в них названия шкал и
   * текст шкалы лжи) — только тому, кому методика их показывает
   * (resultsShownTo внизу файла). null у достоверности — «не сообщается», а
   * не «недостоверно».
   */
  const shown = resultsShownTo(user, survey);

  return c.json(
    {
      id: responseId,
      surveyId,
      submittedAt,
      scores: shown ? scores : [],
      reliable: shown ? profile.reliable : null,
      /*
       * Движок отдаёт предупреждения кодами; фразой они становятся здесь, на
       * языке сдающего (волна 13). Прежде — русской фразой на любом экране.
       */
      warnings: shown ? profile.warnings.map((w) => renderCoded(w, langOf(c))) : [],
      /*
       * Safety-план показывается тому, кто держит устройство, ровно в момент,
       * когда сдача подняла риск, — и только самому обследуемому.
       *
       * Риск — итоговый, тот же, по которому подняты тревоги и проверены
       * правила: критические ответы И полосы шкал (lib/submission →
       * packages/shared/src/risk.ts). Здесь стояло число одних критических
       * ответов, и человек с тяжёлой полосой PHQ-9 или МЛО, у которого в
       * очереди дежурного уже открыт случай, плана безопасности не видел.
       * Повтор из очереди (выше, `duplicate: true`) решает по сохранённым
       * тревогам — то есть по тому же самому.
       */
      safetyPlan: risk.severity !== null && subjectId === user.id ? survey.safetyPlan : null,
      // что назначила автоматика — специалист должен видеть это сразу,
      // а не обнаруживать в списке назначений через неделю
      cascade,
    },
    201,
  );
});

/**
 * Автосохранение черновика.
 *
 * Идемпотентно: на пару (методика, пользователь) держится одно незавершённое
 * прохождение, каждое сохранение перезаписывает его ответы. Тревоги
 * поднимаются здесь же — в этом весь смысл раннего сохранения.
 */
responseRoutes.put("/surveys/:id/draft", async (c) => {
  const user = c.get("user");
  const surveyId = c.req.param("id");
  const input = await parseBody(c.req.raw, draftSchema);

  // та же версия и те же права, что у сдачи: черновик — начало той же сдачи
  const pin = await pinnedVersion(surveyId, input);
  const survey = await getSurvey(surveyId, pin.versionId, langOf(c));
  if (!survey) notFound("err.surveyNotFound");
  if (survey.status !== "published") badRequest("err.surveyNotAvailable");
  if (survey.archivedAt) badRequest("err.surveyArchived");
  if (survey.anonymous) badRequest("err.anonymousNoDraft");
  if (survey.administration !== "self" && !isStaff(user)) forbidden("err.staffFillsOnly");
  await assertMayTake(c, user, survey);
  await assertConsent(c, user);
  if (pin.source === "invalid") badRequest("err.surveyVersionInvalid");

  const existing = await db.query.responses.findFirst({
    where: and(
      eq(responses.surveyId, surveyId),
      eq(responses.userId, user.id),
      eq(responses.status, "in_progress"),
    ),
  });

  const responseId = existing?.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  const validIds = new Set(survey.questions.map((q) => q.id));

  await db.transaction(async (tx) => {
    if (existing) {
      /*
       * Версия черновика следует за клиентом: ответы перезаписываются
       * целиком, и если человек начал заново на новой версии, черновик
       * обязан помнить новую — иначе продолжение открыло бы старую.
       */
      await tx.update(responses)
        .set({ durationMs: input.durationMs, lastSavedAt: now, versionId: survey.versionId })
        .where(eq(responses.id, responseId));
      await tx.delete(answers).where(eq(answers.responseId, responseId));
    } else {
      await tx.insert(responses)
        .values({
          id: responseId,
          surveyId,
          userId: user.id,
          versionId: survey.versionId,
          status: "in_progress",
          startedAt: input.startedAt,
          lastSavedAt: now,
          durationMs: input.durationMs,
        });
    }

    for (const answer of input.answers) {
      if (!validIds.has(answer.questionId)) continue;
      await tx.insert(answers)
        .values({
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
          score: null,
          durationMs: answer.durationMs ?? 0,
          changeCount: answer.changeCount ?? 0,
          visitCount: answer.visitCount ?? 1,
        });
    }

    for (const risk of detectRisks(survey, input.answers as Answer[])) {
      /*
       * Случай — только для нового факта: впервые отмеченного пункта или
       * повышения умеренного до тяжёлого (w12:alerts, внешний разбор P1).
       *
       * Автосохранение пишет тревогу на каждом шаге, и прежде каждый шаг
       * звал attachToCase. Пока случай открыт, это лишь двигало время; но
       * после разбора следующий же шаг с тем же ответом заводил новый
       * случай — пустой, без сигнала, — а повышение до тяжёлого
       * переписывало тревогу внутри разобранного случая, где её уже никто
       * не видел. Теперь тот же ответ ничего не открывает (решение о нём
       * принято), а повышение переносит тревогу в открытый случай и снимает
       * с неё прежнюю отметку разбора: тяжёлого ответа разбирающий не видел.
       *
       * Прочитанная строка может устареть, если тот же черновик
       * сохраняется дважды разом; вставка ниже всё равно упирается в
       * уникальный ключ, так что вторая тревога не появится, а случай
       * найдёт открытым attachToCase под своей блокировкой.
       */
      const prior = await asSystem(() =>
        tx.query.riskAlerts.findFirst({
          where: and(eq(riskAlerts.responseId, responseId), eq(riskAlerts.questionId, risk.questionId)),
          columns: { id: true, severity: true },
        }),
      );
      const upgrade = !!prior && prior.severity !== "severe" && risk.severity === "severe";
      if (prior && !upgrade) {
        /*
         * Тяжесть повышается, а не игнорируется — и не понижается: снятая
         * галочка не отменяет того, что человек её ставил, а случай уже мог
         * уйти в работу. Умеренный остаётся умеренным со свежей подписью.
         */
        if (prior.severity !== "severe") {
          await asSystem(() => tx.update(riskAlerts).set({ label: risk.label, at: now }).where(eq(riskAlerts.id, prior.id)));
        }
        continue;
      }

      const caseId = await attachToCase(tx as never, {
        userId: user.id,
        surveyId,
        severity: risk.severity,
        at: now,
      });
      if (prior) {
        await asSystem(() =>
          tx
            .update(riskAlerts)
            .set({
              label: risk.label,
              severity: risk.severity,
              at: now,
              caseId,
              acknowledgedAt: null,
              acknowledgedBy: null,
              outcome: null,
            })
            .where(eq(riskAlerts.id, prior.id)),
        );
        continue;
      }
      /*
       * Системной ролью, как и случай выше (attachToCase) и тревоги сдачи.
       * Пациенту политика risk_alerts разрешает вставку, но не чтение и не
       * правку, а вставка с ON CONFLICT DO UPDATE требует обоих: под боевой
       * ролью базы автосохранение с критическим ответом падало пятисоткой —
       * черновик не сохранялся вовсе, а ранняя тревога не поднималась
       * никогда (волна 12, найдено тестом под боевой ролью). По той же
       * причине системной ролью читается и прежняя тревога черновика выше:
       * под ролью пациента она была бы невидима, и повышение до тяжёлой не
       * срабатывало бы никогда.
       */
      await asSystem(() => tx.insert(riskAlerts)
        .values({
          id: crypto.randomUUID(),
          responseId,
          surveyId,
          questionId: risk.questionId,
          userId: user.id,
          caseId,
          label: risk.label,
          severity: risk.severity,
          at: now,
        })
        /*
         * Если тот же черновик сохраняется дважды разом, второй шаг
         * упирается в уникальный ключ (прохождение, вопрос). Тяжесть при
         * этом повышается, а не отбрасывается — иначе тревога навсегда
         * осталась бы умеренной при тяжёлом ответе на экране.
         */
        .onConflictDoUpdate({
          target: [riskAlerts.responseId, riskAlerts.questionId],
          set: { label: risk.label, severity: risk.severity, at: now },
          setWhere: sql`${riskAlerts.severity} <> 'severe'`,
        }));
    }
  });

  return c.json({ id: responseId, lastSavedAt: now, answers: input.answers.length });
});

/** Незавершённое прохождение, чтобы продолжить с того же места */
responseRoutes.get("/surveys/:id/draft", async (c) => {
  const user = c.get("user");
  const draft = await db.query.responses.findFirst({
    where: and(
      eq(responses.surveyId, c.req.param("id")),
      eq(responses.userId, user.id),
      eq(responses.status, "in_progress"),
    ),
  });
  if (!draft) return c.json(null);

  const rows = await db.select().from(answers).where(eq(answers.responseId, draft.id));
  return c.json({
    id: draft.id,
    // версия, на которой черновик начат: продолжать и сдавать — по ней
    versionId: draft.versionId,
    startedAt: draft.startedAt,
    lastSavedAt: draft.lastSavedAt,
    durationMs: draft.durationMs,
    answers: rows.map((a) => ({
      questionId: a.questionId,
      optionIds: a.optionIds ?? undefined,
      text: decryptField(a.text) ?? undefined,
      number: a.number ?? undefined,
      date: a.date ?? undefined,
      matrix: a.matrix ?? undefined,
      ranking: a.ranking ?? undefined,
      durationMs: a.durationMs,
      changeCount: a.changeCount,
      visitCount: a.visitCount,
    })),
  });
});

/** Свои прохождения — с баллами, чтобы видеть динамику */
responseRoutes.get("/me/responses", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select()
    .from(responses)
    .where(eq(responses.userId, user.id))
    .orderBy(desc(responses.submittedAt));
  const items = await withScores(rows, user.fullName);
  // свои прохождения — со своими баллами только там, где методика их показывает (resultsShownTo)
  const shownSurveys = new Set(
    rows.length
      ? (
          await db
            .select({ id: surveys.id })
            .from(surveys)
            .where(and(inArray(surveys.id, [...new Set(rows.map((r) => r.surveyId))]), eq(surveys.showResultsToPatient, true)))
        ).map((s) => s.id)
      : [],
  );
  return c.json({
    items: items.map((item) =>
      resultsShownTo(user, { showResultsToPatient: shownSurveys.has(item.surveyId) }) ? item : { ...item, scores: [] },
    ),
  });
});

/** Все прохождения методики — админам */
responseRoutes.get("/surveys/:id/responses", requireStaff, requirePermission("patients.read"), async (c) => {
  const staff = c.get("user");
  await assertSurveyAccess(staff, c.req.param("id"));

  // курсорная пагинация по времени сдачи: limit+1, чтобы узнать «есть ещё».
  // offset-вариант на живой таблице съезжает при вставках между страницами
  const { limit, before, from, to, versionId, userId, patientGroup } = parseQuery(c, responseListQuery);
  const cursor = decodeCursor(before);

  /*
   * Срез по человеку и по группе — с теми же проверками, что у аналитики
   * методики (routes/analytics.ts): чужой пациент и чужая группа отвечают
   * «не найдено», а не пустым списком.
   */
  if (userId) await assertPatientAccess(staff, userId);
  if (patientGroup) await assertPatientGroupAccess(staff, patientGroup);

  /*
   * Имя — полное и через fullNameOf, а не одна расшифрованная фамилия:
   * список стоит на экране аналитики строками «как у пациентов», где человек
   * назван целиком, а у анонимного прохождения вместо фамилии — псевдоним,
   * который fullNameOf и подставляет.
   */
  const rows = await db
    .select({
      response: responses,
      lastName: users.lastName,
      firstName: users.firstName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
    })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(
      and(
        eq(responses.surveyId, c.req.param("id")),
        versionId ? eq(responses.versionId, versionId) : undefined,
        userId ? eq(responses.userId, userId) : undefined,
        patientGroup
          ? sql`${responses.userId} in (select patient_id from patient_group_members where group_id = ${patientGroup})`
          : undefined,
        // сутки учреждения, а не пояса сессии базы — как в аналитике (lib/population.ts);
        // верхняя граница включительно: выбирают день, а не момент
        from ? sql`${responses.submittedAt} >= ${periodFrom(from)}` : undefined,
        to ? sql`${responses.submittedAt} < ${periodTo(to)}` : undefined,
        /*
         * Пара «время и идентификатор», а не одно время.
         *
         * Групповое обследование сдаётся одновременно, метка ставится в JS и
         * совпадает до миллисекунды. Условие «строго раньше» по одному
         * времени выбрасывало на границе страницы всю такую группу целиком,
         * включая непоказанных: из шести прохождений консоль обходила пять,
         * и пометки об этом не было никакой.
         */
        cursor
          ? sql`(${responses.submittedAt}, ${responses.id}) < (${cursor.at}::timestamptz, ${cursor.id})`
          : undefined,
      ),
    )
    .orderBy(desc(responses.submittedAt), desc(responses.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);

  const enriched = await withScores(
    page.map((r) => r.response),
    null,
    new Map(
      page.map((r) => [
        r.response.id,
        r.response.userId
          ? fullNameOf({
              lastName: r.lastName ?? undefined,
              firstName: r.firstName ?? undefined,
              middleName: r.middleName,
              anonymous: r.anonymous ?? undefined,
              pseudonym: r.pseudonym,
            }) || null
          : null,
      ]),
    ),
  );

  // выгрузка списка прохождений — это доступ к данным всех респондентов сразу;
  // список одного человека — чтение его данных, и журнал знает, о ком
  await audit(c, {
    action: "response.list",
    resourceType: "survey",
    resourceId: c.req.param("id"),
    subjectUserId: userId ?? null,
    details: {
      count: enriched.length,
      subjects: [...new Set(rows.map((r) => r.response.userId).filter(Boolean))].length,
      ...(userId ? { userId } : {}),
      ...(patientGroup ? { patientGroup } : {}),
    },
  });

  return c.json({
    rows: enriched,
    hasMore,
    nextBefore: hasMore
      ? encodeCursor(page[page.length - 1]!.response.submittedAt ?? "", page[page.length - 1]!.response.id)
      : null,
  });
});

/**
 * Динамика самого пациента — только по методикам, где психолог явно включил
 * показ результатов. Значения — итоговые (стены/T/доля), с интерпретацией,
 * но без клинических рекомендаций: их даёт специалист на приёме.
 */
responseRoutes.get("/me/dynamics", async (c) => {
  const user = c.get("user");
  const surveyRows = await db
    .select()
    .from(surveys)
    .where(eq(surveys.showResultsToPatient, true));
  if (!surveyRows.length) return c.json({ surveys: [] });

  const own = await db
    .select()
    .from(responses)
    .where(
      and(
        eq(responses.userId, user.id),
        eq(responses.status, "completed"),
        inArray(responses.surveyId, surveyRows.map((s) => s.id)),
      ),
    )
    .orderBy(asc(responses.submittedAt));
  if (!own.length) return c.json({ surveys: [] });

  const scoreRows = await db
    .select({ score: responseScores, scale: scales })
    .from(responseScores)
    .innerJoin(scales, eq(scales.id, responseScores.scaleId))
    .where(inArray(responseScores.responseId, own.map((r) => r.id)));

  const lang = langOf(c);
  const result = surveyRows
    .map((survey) => {
      const mine = own.filter((r) => r.surveyId === survey.id);
      if (!mine.length) return null;
      const byCode = new Map<string, { code: string; title: string; points: { submittedAt: string; value: number; bandLabel: string | null; severity: string | null }[] }>();
      for (const r of mine) {
        for (const { score, scale } of scoreRows.filter((x) => x.score.responseId === r.id)) {
          if (scale.kind !== "clinical") continue; // шкалы лжи пациенту не показываем
          const entry = byCode.get(scale.code) ?? { code: scale.code, title: t(scale.title as never, lang), points: [] };
          entry.points.push({
            submittedAt: r.submittedAt ?? r.startedAt,
            value: score.value,
            bandLabel: score.bandLabel,
            severity: score.severity,
          });
          byCode.set(scale.code, entry);
        }
      }
      return {
        surveyId: survey.id,
        title: t(survey.title as never, lang),
        scales: [...byCode.values()],
      };
    })
    .filter(Boolean);

  return c.json({ surveys: result });
});

/** Детальный разбор прохождения: ответы, баллы и время по каждому вопросу */
responseRoutes.get("/responses/:id", async (c) => {
  const user = c.get("user");
  const response = await db.query.responses.findFirst({
    where: eq(responses.id, c.req.param("id")),
  });
  if (!response) notFound("err.responseNotFound");
  if (!isStaff(user) && response.userId !== user.id) {
    forbidden("err.responseOwnerOrStaffOnly");
  }
  // сотрудник видит карту, только если методика в зоне его ответственности
  if (isStaff(user) && response.userId !== user.id) {
    await assertSurveyAccess(user, response.surveyId);
  }

  // читаем методику той версии, которую респондент реально видел
  const survey = await getSurveyForResponse(response.id, langOf(c));
  if (!survey) notFound("err.surveyNotFound");

  const [answerRows, scoreRows, eventRows] = await Promise.all([
    db.select().from(answers).where(eq(answers.responseId, response.id)),
    db.select().from(responseScores).where(eq(responseScores.responseId, response.id)),
    db.select().from(answerEvents).where(eq(answerEvents.responseId, response.id)),
  ]);

  const eventsByQuestion = new Map<string, typeof eventRows>();
  for (const e of eventRows.sort((a, b) => a.sequence - b.sequence)) {
    const list = eventsByQuestion.get(e.questionId) ?? [];
    list.push(e);
    eventsByQuestion.set(e.questionId, list);
  }

  const answersByQuestion = new Map(answerRows.map((a) => [a.questionId, a]));
  const scaleTitles = new Map(survey.scales.map((s) => [s.id, s]));
  /*
   * Вес варианта — только персоналу. Тот же маршрут открывает своё
   * прохождение сам обследуемый, а вес подсказывает, какой ответ
   * «правильный», — при повторном замере это уже не измерение. Граница
   * держится здесь, на сервере, а не на том, что кабинет весов пока не
   * запрашивает.
   */
  const staffView = isStaff(user);

  await audit(c, {
    action: "response.read",
    resourceType: "response",
    resourceId: response.id,
    subjectUserId: response.userId,
    details: { surveyId: survey.id, ownRecord: response.userId === user.id },
  });

  return c.json({
    id: response.id,
    /*
     * Обследуемый. Графикам прохождения нужна динамика этого человека по
     * этой методике, а адрес прохождения человека не несёт. Нового здесь
     * читающий не узнаёт: прохождение и так открыто только ему самому и
     * персоналу в зоне методики, а чтение уже записано в журнал выше с тем же
     * subjectUserId. У анонимной методики и у заполненного со слов другого
     * здесь null — прохождение с человеком не связано намеренно.
     */
    userId: response.userId,
    survey: {
      id: survey.id,
      title: survey.title,
      scoringEnabled: survey.scoringEnabled,
      // номер той версии, которую человек проходил, — по нему экран просит методику ?version=N
      versionNumber: survey.versionNumber,
    },
    status: response.status,
    startedAt: response.startedAt,
    submittedAt: response.submittedAt,
    durationMs: response.durationMs,
    // баллы и полосы — только тому, кому методика их показывает (resultsShownTo внизу файла)
    scores: (resultsShownTo(user, survey) ? scoreRows : []).map((s) => {
      const scale = scaleTitles.get(s.scaleId);
      const band = s.bandLabel
        ? { id: null, label: s.bandLabel, severity: s.severity!, description: null, grade: null, recommendation: null }
        : null;
      /*
       * Лестница полос — все ступени шкалы той версии, которую человек
       * проходил, с пометкой попавшей. Одной попавшей экрану мало: макет
       * рисует все «від — до», а собирать их из действующей методики нельзя —
       * границы могли перерисовать после прохождения.
       *
       * Попавшая ищется тем же сравнением, что в движке подсчёта
       * (packages/shared/src/scoring.ts), и только когда полоса при подсчёте
       * вообще нашлась: без неё балл не нормирован и не в тех единицах, в
       * которых заданы ступени. Запасной путь — по сохранённой подписи: она
       * записана в момент подсчёта и надёжнее, чем значение, округлённое
       * иначе.
       */
      const ladder = [...(scale?.bands ?? [])].sort((a, b) => a.minScore - b.minScore || a.position - b.position);
      const hit = band
        ? (bandFor(ladder, s.value) ?? ladder.find((b) => b.label === band.label))
        : undefined;
      return {
        scaleId: s.scaleId,
        scaleCode: scale?.code ?? "",
        scaleTitle: scale?.title ?? "",
        kind: "clinical" as const,
        correctedScore: s.rawScore,
        value: s.value,
        /*
         * Удалось ли нормирование — из сохранённого при подсчёте. Тип
         * ответа (ScoreResult) обещал это поле давно, а маршрут его не
         * отдавал, и экран не мог отличить сырой балл от T-балла: без
         * полосы «64» читалось бы как T 64, хотя это сырой балл без нормы.
         */
        normalized: s.normalized,
        normalization: s.normalization,
        rawScore: s.rawScore,
        maxScore: s.maxScore,
        percent: s.percent,
        band,
        bands: ladder.map(
          (b): ResponseDetailBand => ({
            id: b.id,
            minScore: b.minScore,
            maxScore: b.maxScore,
            label: b.label,
            severity: b.severity,
            description: b.description,
            grade: b.grade,
            recommendation: b.recommendation,
            hit: b.id === hit?.id,
          }),
        ),
      };
    }),
    answers: survey.questions
      .filter((q) => q.type !== "info")
      .map((q) => {
        const a = answersByQuestion.get(q.id);
        return {
          questionId: q.id,
          title: q.title,
          type: q.type,
          position: q.position,
          answered: !!a && !a.skipped,
          optionIds: a?.optionIds ?? null,
          /*
           * Варианты пункта — вместе с ответом.
           *
           * Без них наружу уходит `optionIds`, то есть набор случайных
           * идентификаторов, и читающий обязан отдельно догрузить методику
           * ТОЙ ЖЕ версии, которую проходил обследуемый, и сопоставить
           * руками. На разборе случая риска это ровно тот шаг, на котором
           * ошибаются: берут действующую версию, а человек проходил
           * прошлую, — и «что он ответил» получается из другого набора
           * вариантов. Здесь версия уже правильная: методика прочитана по
           * прохождению.
           *
           * Пометка риска идёт следом: разбирающему нужно видеть не только
           * что человек выбрал, но и почему этот выбор поднял тревогу.
           */
          options: q.options.map((o) => ({
            id: o.id,
            text: o.text,
            riskFlag: o.riskFlag,
            riskSeverity: o.riskSeverity,
            score: staffView ? o.score : null,
          })),
          text: decryptField(a?.text ?? null),
          number: a?.number ?? null,
          date: a?.date ?? null,
          matrix: a?.matrix ?? null,
          ranking: a?.ranking ?? null,
          score: a?.score ?? null,
          durationMs: a?.durationMs ?? 0,
          changeCount: a?.changeCount ?? 0,
          visitCount: a?.visitCount ?? 0,
          events: (eventsByQuestion.get(q.id) ?? []).map((e) => ({
            kind: e.kind,
            elapsedMs: e.elapsedMs,
            at: e.at,
            value: e.value,
          })),
        };
      }),
  });
});

async function withScores(
  rows: (typeof responses.$inferSelect)[],
  fallbackName: string | null,
  namesById?: Map<string, string | null>,
): Promise<SurveyResponse[]> {
  if (!rows.length) return [];
  const scoreRows = await db
    .select()
    .from(responseScores)
    .where(inArray(responseScores.responseId, rows.map((r) => r.id)));

  const scaleRows = scoreRows.length
    ? await db.select().from(scales).where(inArray(scales.id, scoreRows.map((s) => s.scaleId)))
    : [];
  const scaleById = new Map(scaleRows.map((s) => [s.id, s]));

  const byResponse = new Map<string, ScoreResult[]>();
  for (const s of scoreRows) {
    const list = byResponse.get(s.responseId) ?? [];
    list.push({
      scaleId: s.scaleId,
      scaleCode: scaleById.get(s.scaleId)?.code ?? "",
      scaleTitle: t(scaleById.get(s.scaleId)?.title as never),
      kind: "clinical",
      // из сохранённого, а не выведенное задним числом: пол и нормы могли
      // измениться с момента подсчёта
      normalized: s.normalized,
      correctedScore: s.rawScore,
      value: s.value,
      normalization: s.normalization,
      rawScore: s.rawScore,
      maxScore: s.maxScore,
      percent: s.percent,
      band: s.bandLabel
        ? { id: null, label: s.bandLabel, severity: s.severity!, description: null, grade: null, recommendation: null }
        : null,
    });
    byResponse.set(s.responseId, list);
  }

  return rows.map((r) => ({
    id: r.id,
    surveyId: r.surveyId,
    userId: r.userId,
    userName: namesById?.get(r.id) ?? fallbackName,
    status: r.status,
    startedAt: r.startedAt,
    submittedAt: r.submittedAt,
    durationMs: r.durationMs,
    scores: byResponse.get(r.id) ?? [],
  }));
}


/**
 * Видит ли читающий баллы и полосы этого прохождения (волна 12, engine).
 *
 * Сотрудник — всегда. Обследуемый — только если психолог включил у методики
 * показ результатов (showResultsToPatient). У PHQ-9, PCL-5, PQ-16 он
 * выключен намеренно: балл без разговора со специалистом — «тяжёлая
 * депрессия» на экране телефона в одиночестве. Флаг до сих пор уважала
 * только динамика (/me/dynamics), а сдача, список своих прохождений и
 * разбор прохождения отдавали баллы и полосу как есть (клиническое ревью:
 * `{"raw":24,"band":"Тяжка депресія"}` в ответе на сдачу).
 *
 * Кризисная карточка этим правилом не закрывается: она — не результат, а
 * помощь. В ней нет ни балла, ни полосы — только что делать и куда звонить,
 * и показывается она ровно тогда, когда риск поднят; спрятать её вместе с
 * баллом значило бы оставить человека с риском без плана безопасности ради
 * того, чтобы не показать ему число.
 */
function resultsShownTo(user: { role: string }, survey: { showResultsToPatient: boolean } | null | undefined): boolean {
  return isStaff(user as never) || survey?.showResultsToPatient === true;
}
