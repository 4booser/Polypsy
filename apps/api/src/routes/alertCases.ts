import { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { t, type AlertCase, type AlertSignal, type AlertSignalBasis, type Page } from "@quizzy/shared";
import { db } from "../db";
import {
  alertCases,
  answers,
  auditLog,
  options,
  questions,
  responseScores,
  responses,
  riskAlerts,
  scaleBands,
  scales,
  surveys,
  users,
} from "../db/schema";
import { audit } from "../lib/audit";
import { publish } from "../lib/events";
import { fullNameOf } from "../lib/auth";
import { badRequest, langOf, notFound, parseQuery } from "../lib/http";
import { canAccessSurvey, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { z } from "zod";

/**
 * Случаи риска — то, что разбирает дежурный специалист.
 *
 * Список курсорный: на четырёхстах открытых случаях отдавать всё разом
 * бессмысленно, а нумерованные страницы врут — список меняется прямо во
 * время разбора, и «страница 3» через минуту показывает другое.
 */
export const alertCaseRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 */
alertCaseRoutes.use("*", requireAuth, requireStaff, requirePermission("alerts.review"));

/** Сколько сигналов показывать внутри случая сразу */
const SIGNALS_PREVIEW = 12;

const listQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Number(v) : 30))
    .pipe(z.number().int().min(1).max(100)),
  // курсор — база64 от «метка времени + идентификатор»: около 90 знаков
  cursor: z.string().max(200).optional(),
  all: z.string().optional(),
  severity: z.enum(["moderate", "severe"]).optional(),
  unit: z.string().max(120).optional(),
  assigned: z.string().max(80).optional(),
  surveyId: z.string().max(80).optional(),
  search: z.string().max(120).optional(),
});

/**
 * Порядок очереди: тяжёлые впереди, дальше — свежие.
 *
 * Раньше сортировка делалась в приложении, уже после выборки страницы, а
 * выбирала база по одному времени последней тревоги. То есть порядок
 * действовал внутри страницы и только: тяжёлый случай, попавший на третью
 * страницу, там и оставался, а очередь на первом экране выглядела
 * упорядоченной. Тяжесть — свойство самого случая и не меняется со временем,
 * поэтому её можно поставить в ORDER BY и в курсор.
 *
 * Просроченность в ключ не берётся намеренно: она зависит от текущего
 * времени, и случай, ставший просроченным между двумя страницами, переехал
 * бы через границу — часть записей человек не увидел бы вовсе. Она остаётся
 * пометкой на строке.
 */
const severityRank = sql<number>`(case when ${alertCases.severity} = 'severe' then 1 else 0 end)`;

/**
 * Курсор — «тяжесть + время последней тревоги + идентификатор».
 *
 * Идентификатор нужен даже при точном времени: у случаев, заведённых в одну
 * секунду, порядок между страницами разъехался бы и часть записей человек бы
 * не увидел вовсе.
 */
function encodeCursor(row: { severity: string; lastAlertAt: string; id: string }): string {
  const rank = row.severity === "severe" ? 1 : 0;
  return Buffer.from(`${rank}|${row.lastAlertAt}|${row.id}`).toString("base64url");
}
function decodeCursor(raw: string): { rank: number; at: string; id: string } | null {
  try {
    const [rank, at, id] = Buffer.from(raw, "base64url").toString().split("|");
    return at && id && (rank === "0" || rank === "1") ? { rank: Number(rank), at, id } : null;
  } catch {
    return null;
  }
}

/** Список идентификаторов для сырого SQL: drizzle внутри sql`` их не разложит. */
function sqlIds(ids: string[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

alertCaseRoutes.get("/", async (c) => {
  // язык читателя: t() без него отдаёт украинский всегда
  const lang = langOf(c);
  const user = c.get("user");
  const q = parseQuery(c, listQuery);

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json({ items: [], nextCursor: null, total: 0 } satisfies Page<AlertCase>);

  /*
   * Область видимости считается по СИГНАЛАМ случая, а не по методике, с
   * которой он начался.
   *
   * Случай теперь заводится на человека и собирает сигналы разных методик
   * (см. attachToCase). Колонка survey_id осталась — она говорит, с чего
   * случай начался, — но правом на просмотр она больше не заведует: случай,
   * начавшийся с методики А и продолжившийся тревогой по методике Б, иначе
   * был бы невидим для специалиста, ведущего Б, и при этом показывал бы
   * сигналы Б специалисту, ведущему только А.
   *
   * Методика начала оставлена вторым основанием: случай, видимый вчера, не
   * должен пропасть сегодня.
   */
  const inScope = sql`exists (
    select 1 from risk_alerts ra
    where ra.case_id = ${alertCases.id} and ra.survey_id in ${sqlIds(surveyIds)}
  )`;
  const filters: SQL[] = [or(inArray(alertCases.surveyId, surveyIds), inScope)!];
  if (q.all !== "1") filters.push(isNull(alertCases.acknowledgedAt));
  if (q.severity) filters.push(eq(alertCases.severity, q.severity));
  if (q.surveyId) {
    filters.push(
      or(
        eq(alertCases.surveyId, q.surveyId),
        sql`exists (select 1 from risk_alerts ra where ra.case_id = ${alertCases.id} and ra.survey_id = ${q.surveyId})`,
      )!,
    );
  }
  if (q.assigned === "me") filters.push(eq(alertCases.assignedTo, user.id));
  else if (q.assigned === "none") filters.push(isNull(alertCases.assignedTo));
  else if (q.assigned) filters.push(eq(alertCases.assignedTo, q.assigned));
  if (q.unit) filters.push(eq(users.unit, q.unit));

  /*
   * Поиск по фамилии идёт по расшифрованным данным в приложении, а не SQL:
   * ФИО хранится зашифрованным, и LIKE по шифртексту ничего не найдёт.
   * Поэтому при поиске выбираем шире и фильтруем после расшифровки — на
   * четырёхстах случаях это доли миллисекунды, а компромисс честнее, чем
   * заводить незашифрованную копию имени ради удобного запроса.
   */
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    // сравнение тройкой целиком: по частям оно разъезжается на границах
    filters.push(
      sql`(${severityRank}, ${alertCases.lastAlertAt}, ${alertCases.id})
          < (${cursor.rank}, ${cursor.at}::timestamptz, ${cursor.id})`,
    );
  }

  const where = and(...filters);
  const overfetch = q.search ? 400 : q.limit + 1;

  const rows = await db
    .select({
      c: alertCases,
      surveyTitle: surveys.title,
      escalateMinutes: surveys.alertEscalateMinutes,
      unit: users.unit,
      // имена полей ровно как ждёт fullNameOf: он же расшифровывает и умеет
      // про псевдонимы, дублировать эту логику здесь незачем
      firstName: users.firstName,
      lastName: users.lastName,
      middleName: users.middleName,
      anonymous: users.anonymous,
      pseudonym: users.pseudonym,
      // считаются только сигналы по доступным методикам — столько же, сколько
      // будет показано ниже: число, не сходящееся со списком, хуже отсутствия
      signalCount: sql<number>`(select count(*)::int from risk_alerts ra
        where ra.case_id = ${alertCases.id} and ra.survey_id in ${sqlIds(surveyIds)})`,
    })
    .from(alertCases)
    .innerJoin(surveys, eq(surveys.id, alertCases.surveyId))
    .innerJoin(users, eq(users.id, alertCases.userId))
    .where(where)
    .orderBy(desc(severityRank), desc(alertCases.lastAlertAt), desc(alertCases.id))
    .limit(overfetch);

  const named = rows.map((r) => ({ ...r, userName: fullNameOf(r as never) }));
  const needle = q.search?.trim().toLowerCase();
  const matched = needle
    ? named.filter((r) => r.userName.toLowerCase().includes(needle))
    : named;

  const page = matched.slice(0, q.limit);
  const hasMore = matched.length > q.limit;

  // сигналы одним запросом на страницу, а не по запросу на случай
  const caseIds = page.map((r) => r.c.id);
  const signalsByCase = new Map<string, AlertSignal[]>();
  if (caseIds.length) {
    /*
     * Связь с пунктом и со шкалой — ЛЕВЫМИ соединениями.
     *
     * У сигнала по полосе шкалы пункта нет, у сигнала по пункту нет шкалы;
     * внутреннее соединение выбросило бы половину сигналов из списка, ничем
     * себя не выдав — случай остался бы в очереди, а сигналы внутри него
     * молча пропали.
     */
    const sig = await db
      .select({ a: riskAlerts, questionTitle: questions.title, scaleTitle: scales.title })
      .from(riskAlerts)
      .leftJoin(questions, eq(questions.id, riskAlerts.questionId))
      .leftJoin(scales, eq(scales.id, riskAlerts.scaleId))
      .where(and(inArray(riskAlerts.caseId, caseIds), inArray(riskAlerts.surveyId, surveyIds)))
      .orderBy(desc(riskAlerts.at));
    for (const s of sig) {
      const list = signalsByCase.get(s.a.caseId!) ?? [];
      if (list.length < SIGNALS_PREVIEW) {
        list.push({
          id: s.a.id,
          responseId: s.a.responseId,
          kind: s.a.questionId ? "option" : "band",
          questionId: s.a.questionId,
          // у сигнала по шкале в этом поле стоит название шкалы: место одно,
          // и подписывать его «пункт» было бы неправдой ровно в половине строк
          questionTitle: t((s.questionTitle ?? s.scaleTitle) as never, lang),
          label: s.a.label,
          severity: s.a.severity,
          at: s.a.at,
        });
      }
      signalsByCase.set(s.a.caseId!, list);
    }
  }

  const staffIds = [
    ...new Set(page.flatMap((r) => [r.c.assignedTo, r.c.acknowledgedBy]).filter((x): x is string => !!x)),
  ];
  const staffNames = new Map<string, string>();
  if (staffIds.length) {
    for (const u of await db.select().from(users).where(inArray(users.id, staffIds))) {
      staffNames.set(u.id, fullNameOf(u));
    }
  }

  const now = Date.now();
  const items: AlertCase[] = page.map((r) => {
    /*
     * Просроченность считается на чтении: правило зависит только от времени
     * и настройки методики, а фоновое задание добавило бы точку отказа,
     * ничего не дав.
     */
    const openedMs = r.c.acknowledgedAt
      ? new Date(r.c.acknowledgedAt).getTime() - new Date(r.c.openedAt).getTime()
      : now - new Date(r.c.openedAt).getTime();
    const minutesOpen = Math.max(0, Math.round(openedMs / 60_000));

    return {
      id: r.c.id,
      userId: r.c.userId,
      userName: r.userName,
      unit: r.unit,
      surveyId: r.c.surveyId,
      surveyTitle: t(r.surveyTitle as never, lang),
      severity: r.c.severity,
      openedAt: r.c.openedAt,
      lastAlertAt: r.c.lastAlertAt,
      signalCount: Number(r.signalCount ?? 0),
      signals: signalsByCase.get(r.c.id) ?? [],
      minutesOpen,
      overdue: !r.c.acknowledgedAt && r.escalateMinutes !== null && minutesOpen >= r.escalateMinutes,
      assignedTo: r.c.assignedTo,
      assignedToName: r.c.assignedTo ? (staffNames.get(r.c.assignedTo) ?? null) : null,
      acknowledgedBy: r.c.acknowledgedBy,
      acknowledgedByName: r.c.acknowledgedBy ? (staffNames.get(r.c.acknowledgedBy) ?? null) : null,
      acknowledgedAt: r.c.acknowledgedAt,
      note: r.c.note,
      outcome: r.c.outcome,
      mergedFromLegacy: r.c.mergedFromLegacy,
    };
  });

  /*
   * Порядок задан в ORDER BY и здесь не переставляется. Пересортировка
   * страницы после выборки как раз и создавала видимость упорядоченной
   * очереди: она наводила порядок среди тридцати уже выбранных случаев и
   * ничего не могла сделать с тридцать первым.
   */

  // общее число — только на первой странице: считать его на каждой лишняя работа
  let total: number | undefined;
  if (!cursor && !needle) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(alertCases)
      .innerJoin(users, eq(users.id, alertCases.userId))
      .where(where);
    total = row?.n ?? 0;
  }

  await audit(c, {
    action: "alert.list",
    details: { returned: items.length, filters: { ...q, cursor: undefined } },
  });

  const last = page[page.length - 1];
  return c.json({
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ severity: last.c.severity, lastAlertAt: last.c.lastAlertAt, id: last.c.id })
        : null,
    total,
  } satisfies Page<AlertCase>);
});

/** Подразделения, встречающиеся среди случаев — для фильтра */
alertCaseRoutes.get("/units", async (c) => {
  const scope = await surveyScopeFilter(c.get("user"));
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const ids = scoped.map((s) => s.id);
  if (!ids.length) return c.json({ items: [] });

  const rows = await db
    .selectDistinct({ unit: users.unit })
    .from(alertCases)
    .innerJoin(users, eq(users.id, alertCases.userId))
    .where(and(inArray(alertCases.surveyId, ids), isNotNull(users.unit)));
  return c.json({ items: rows.map((r) => r.unit).filter(Boolean).sort() });
});

async function loadCase(user: { id: string; role: string }, id: string) {
  const row = await db.query.alertCases.findFirst({ where: eq(alertCases.id, id) });
  if (!row) notFound("err.caseNotFound");
  if (!(await canAccessSurvey(user as never, row.surveyId))) notFound("err.caseNotFound");
  return row;
}

/**
 * Основание тревоги: по какой методике и какому ответу или полосе шкалы
 * система решила, что у человека риск.
 *
 * Отдельный маршрут, а не поля в самой очереди. Очередь отдаёт тридцать
 * случаев со всеми их сигналами, а основание читают у одного, и на который
 * смотрят — заранее неизвестно. Тянуть ответы, варианты, баллы и полосы на
 * все тридцать значило бы платить четырьмя запросами за то, что откроют
 * один раз.
 *
 * Сигнал бывает двух видов, и подписаны они по-разному:
 *
 * `option` — человек отметил вариант, помеченный как критический. Основание
 * здесь — сам пункт и то, что человек в нём выбрал: «Пункт 9. Мысли, что
 * лучше было бы умереть → Почти каждый день». Без отмеченного варианта
 * подпись врёт наполовину: она называет пункт, но не говорит, чем ответ
 * плох, — а критическим бывает один вариант из пяти.
 *
 * `band` — суммарный балл шкалы попал в полосу. Пункта здесь нет вовсе (см.
 * risk_alerts.question_id), и называть какой-то один значило бы назвать
 * виновным случайный. Основание — шкала, значение в единицах нормировки и
 * границы полосы: «Суицидальный риск: 2 стена, полоса 1–2 — крайне низкий
 * уровень». Без границ значение нечитаемо: 2 — это много или мало, зависит
 * от того, из чего оно.
 */
alertCaseRoutes.get("/:id/signals", async (c) => {
  const lang = langOf(c);
  const user = c.get("user");
  const row = await loadCase(user, c.req.param("id"));

  /*
   * Сигналы фильтруются по области видимости так же, как в очереди: случай
   * собирает тревоги разных методик, и специалист, ведущий одну из них, не
   * должен читать ответы по чужой. Иначе основание стало бы обходным путём к
   * данным, которых человек не видит нигде больше.
   */
  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return c.json({ items: [] satisfies AlertSignalBasis[] });

  const signals = await db
    .select({
      a: riskAlerts,
      surveyTitle: surveys.title,
      submittedAt: responses.submittedAt,
      questionTitle: questions.title,
      questionPosition: questions.position,
      scaleCode: scales.code,
      scaleTitle: scales.title,
    })
    .from(riskAlerts)
    .innerJoin(surveys, eq(surveys.id, riskAlerts.surveyId))
    .innerJoin(responses, eq(responses.id, riskAlerts.responseId))
    /*
     * Пункт и шкала — ЛЕВЫМИ соединениями: у сигнала по полосе нет пункта, у
     * сигнала по варианту нет шкалы. Внутреннее соединение выбросило бы
     * половину сигналов, ничем себя не выдав.
     */
    .leftJoin(questions, eq(questions.id, riskAlerts.questionId))
    .leftJoin(scales, eq(scales.id, riskAlerts.scaleId))
    .where(and(eq(riskAlerts.caseId, row.id), inArray(riskAlerts.surveyId, surveyIds)))
    .orderBy(desc(riskAlerts.at));

  if (!signals.length) return c.json({ items: [] satisfies AlertSignalBasis[] });

  /*
   * Что человек отметил — читается из ответов, а не из подписи тревоги.
   *
   * В `label` лежит текст, собранный в момент срабатывания: либо заданная
   * методикой подпись риска, либо «пункт — вариант». Первая ничего не
   * говорит об ответе вовсе («Суицидальные мысли»), и разбирающему пришлось
   * бы верить ей на слово. Ответ же лежит рядом и не меняется задним числом.
   */
  const optionSignals = signals.filter((s) => s.a.questionId);
  const answerRows = optionSignals.length
    ? await db
        .select()
        .from(answers)
        .where(
          and(
            inArray(answers.responseId, [...new Set(optionSignals.map((s) => s.a.responseId))]),
            inArray(answers.questionId, [...new Set(optionSignals.map((s) => s.a.questionId!))]),
          ),
        )
    : [];
  const optionRows = optionSignals.length
    ? await db
        .select()
        .from(options)
        .where(inArray(options.questionId, [...new Set(optionSignals.map((s) => s.a.questionId!))]))
    : [];
  const answerBy = new Map(answerRows.map((a) => [`${a.responseId}|${a.questionId}`, a]));
  const optionText = new Map(optionRows.map((o) => [o.id, t(o.text as never, lang)]));

  const bandSignals = signals.filter((s) => s.a.scaleId);
  const scoreRows = bandSignals.length
    ? await db
        .select()
        .from(responseScores)
        .where(
          and(
            inArray(responseScores.responseId, [...new Set(bandSignals.map((s) => s.a.responseId))]),
            inArray(responseScores.scaleId, [...new Set(bandSignals.map((s) => s.a.scaleId!))]),
          ),
        )
    : [];
  const bandRows = bandSignals.length
    ? await db
        .select()
        .from(scaleBands)
        .where(inArray(scaleBands.scaleId, [...new Set(bandSignals.map((s) => s.a.scaleId!))]))
    : [];
  const scoreBy = new Map(scoreRows.map((s) => [`${s.responseId}|${s.scaleId}`, s]));

  const items: AlertSignalBasis[] = signals.map((s) => {
    const answer = s.a.questionId ? answerBy.get(`${s.a.responseId}|${s.a.questionId}`) : undefined;
    const score = s.a.scaleId ? scoreBy.get(`${s.a.responseId}|${s.a.scaleId}`) : undefined;
    /*
     * Полоса ищется по значению, а не по совпадению подписи: подпись в
     * `response_scores` уже разрешена на язык, на котором считали, и на
     * другом языке не совпала бы ни с одной полосой — границы пропали бы
     * ровно у того читателя, который переключил язык.
     */
    const band =
      score && score.value !== null
        ? bandRows.find(
            (b) => b.scaleId === s.a.scaleId && score.value >= b.minScore && score.value <= b.maxScore,
          )
        : undefined;

    return {
      id: s.a.id,
      kind: s.a.questionId ? "option" : "band",
      responseId: s.a.responseId,
      surveyId: s.a.surveyId,
      surveyTitle: t(s.surveyTitle as never, lang),
      label: s.a.label,
      severity: s.a.severity,
      at: s.a.at,
      responseSubmittedAt: s.submittedAt,

      questionId: s.a.questionId,
      // человек читает бланк по номерам, а не по нулевому смещению
      questionNumber: s.questionPosition === null ? null : s.questionPosition + 1,
      questionTitle: s.questionTitle ? t(s.questionTitle as never, lang) : null,
      /*
       * Матричный ответ тоже отдаёт выбранное: у матрицы вариант лежит в
       * значениях `matrix`, а не в `optionIds`, и без него сигнал по матрице
       * остался бы без основания вовсе.
       */
      pickedOptions: [
        ...(answer?.optionIds ?? []),
        ...Object.values(answer?.matrix ?? {}),
      ]
        .map((id) => optionText.get(id))
        .filter((x): x is string => !!x),
      answeredNumber: answer?.number ?? null,

      scaleId: s.a.scaleId,
      scaleCode: s.scaleCode,
      scaleTitle: s.scaleTitle ? t(s.scaleTitle as never, lang) : null,
      scaleValue: score?.value ?? null,
      scaleRawScore: score?.rawScore ?? null,
      normalization: score?.normalization ?? null,
      bandLabel: score?.bandLabel ?? null,
      bandMin: band?.minScore ?? null,
      bandMax: band?.maxScore ?? null,
      bandDescription: band ? t(band.description as never, lang) || null : null,
      bandRecommendation: band ? t(band.recommendation as never, lang) || null : null,
    };
  });

  /*
   * Чтение оснований — это доступ к ответам обследуемого по пунктам, а не
   * просмотр карточки очереди. В журнал оно должно попадать отдельно от
   * `alert.list`: иначе «открыл очередь» и «прочитал, что человек ответил
   * про мысли о смерти» неотличимы.
   */
  await audit(c, {
    action: "alert.signals",
    resourceType: "alert_case",
    resourceId: row.id,
    subjectUserId: row.userId,
    details: { signals: items.length },
  });

  return c.json({ items });
});

/**
 * Кто и что делал со случаем.
 *
 * Отдельного журнала передач нет намеренно: всё уже пишется в журнал
 * доступа, и вторая запись о том же означала бы два источника истины о
 * клиническом решении. Здесь просто выборка по этому случаю.
 *
 * Нужно это при передаче смены: заступивший видит, кто брал случай, кто
 * отпускал и почему он до сих пор открыт.
 */
alertCaseRoutes.get("/:id/history", async (c) => {
  const user = c.get("user");
  const row = await loadCase(user, c.req.param("id"));

  const rows = await db
    .select({ entry: auditLog, actor: users })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(eq(auditLog.resourceId, row.id), eq(auditLog.resourceType, "alert_case")))
    .orderBy(desc(auditLog.at))
    .limit(50);

  return c.json({
    items: rows.map((r) => ({
      action: r.entry.action,
      at: r.entry.at,
      actorName: r.actor ? fullNameOf(r.actor) : (r.entry.actorEmail ?? "—"),
      details: r.entry.details,
    })),
  });
});

/**
 * Взять случай на себя или отпустить.
 *
 * Без явной пометки двое дежурных разбирают одного человека дважды и узнают
 * об этом только из журнала.
 */
alertCaseRoutes.post("/:id/assign", async (c) => {
  const user = c.get("user");
  const row = await loadCase(user, c.req.param("id"));
  if (row.acknowledgedAt) badRequest("err.caseAlreadyHandled");

  const body = await c.req.json().catch(() => ({}));
  const release = body?.release === true;

  if (!release && row.assignedTo && row.assignedTo !== user.id) {
    badRequest("err.caseTakenByOther");
  }

  const [updated] = await db
    .update(alertCases)
    .set(
      release
        ? { assignedTo: null, assignedAt: null }
        : { assignedTo: user.id, assignedAt: new Date().toISOString() },
    )
    .where(eq(alertCases.id, row.id))
    .returning();

  await audit(c, {
    action: release ? "alert.release" : "alert.assign",
    resourceType: "alert_case",
    resourceId: row.id,
    subjectUserId: row.userId,
  });
  /*
   * Кто взял случай — видно всем сразу, а не через минуту: иначе двое
   * дежурных разбирают одного человека и узнают об этом из журнала.
   */
  await publish(db, {
    kind: "case.changed",
    surveyIds: [row.surveyId],
    userId: row.userId,
    at: new Date().toISOString(),
  });
  return c.json(updated);
});

/**
 * Разбор случая: одно клиническое решение о человеке.
 *
 * Исход ставится на случай целиком — специалист решает про человека, а не
 * про каждый сработавший пункт по отдельности. Это же делает калибровку
 * порогов методологически корректной: пять пунктов одного обследуемого не
 * пять независимых наблюдений.
 */
alertCaseRoutes.patch("/:id", async (c) => {
  const user = c.get("user");
  const row = await loadCase(user, c.req.param("id"));

  const body = await c.req.json().catch(() => ({}));
  const outcome = ["confirmed", "not_confirmed", "needs_followup"].includes(body?.outcome)
    ? (body.outcome as "confirmed" | "not_confirmed" | "needs_followup")
    : null;
  if (!outcome) badRequest("err.outcomeRequired");

  const at = new Date().toISOString();
  const note = typeof body?.note === "string" ? body.note.slice(0, 2000) : null;

  await db.transaction(async (tx) => {
    await tx
      .update(alertCases)
      .set({ acknowledgedBy: user.id, acknowledgedAt: at, note, outcome })
      .where(eq(alertCases.id, row.id));

    /*
     * Сигналы внутри случая помечаются разобранными тем же решением: они не
     * должны остаться «висящими» в старых выборках и счётчиках, которые
     * смотрят на risk_alerts напрямую.
     */
    await tx
      .update(riskAlerts)
      .set({ acknowledgedBy: user.id, acknowledgedAt: at, outcome })
      .where(and(eq(riskAlerts.caseId, row.id), isNull(riskAlerts.acknowledgedAt)));
  });

  await audit(c, {
    action: "alert.acknowledge",
    resourceType: "alert_case",
    resourceId: row.id,
    subjectUserId: row.userId,
    details: { outcome, note },
  });

  await publish(db, {
    kind: "case.changed",
    surveyIds: [row.surveyId],
    userId: row.userId,
    at,
  });

  return c.json({ id: row.id, outcome, acknowledgedAt: at });
});
