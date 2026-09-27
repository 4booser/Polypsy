import { Hono } from "hono";
import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import {
  bandFor,
  queryDate,
  queryInt,
  t,
  type AlertCase,
  type AlertCaseFacets,
  type AlertCasePage,
  type AlertSignal,
  type AlertSignalBasis,
} from "@quizzy/shared";
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
import { periodFrom, periodTo } from "../lib/population";
import { badRequest, badRequestDetail, conflict, langOf, notFound, parseQuery } from "../lib/http";
import { assertPatientGroupAccess, canAccessSurvey, surveyScopeFilter } from "../lib/scope";
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

/** Пустое значение в адресе — «фильтр не задан», а не кривое значение */
const opt = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

/**
 * Параметры очереди — строго.
 *
 * Прежде схема пропускала почти всё: `all` принимал любую строку,
 * `assigned` — тоже, битый курсор молча превращался в «с начала» (дежурный
 * листал и получал первую страницу повторно), курсор с негодной меткой
 * времени ронял запрос в 500, а лишний параметр отбрасывался — и опечатка
 * `severty=severe` показывала все случаи тому, кто был уверен, что смотрит
 * тяжёлые. Очередь, показывающая не то, что просили, и молчащая об этом,
 * опаснее отказа, поэтому кривое значение и незнакомый параметр — 400 с
 * перечнем, что именно не так.
 *
 * Отбор (внешний разбор: экран становился непригодным на сотнях случаев):
 *   status      open · resolved · all (прежний `all=1` = all — его шлёт мобилка)
 *   group       person · case — см. «Группировка» у маршрута
 *   severity    moderate · severe
 *   assigned    me · none · others · идентификатор сотрудника
 *   unit        подразделение
 *   surveyId    методика (начальная или любого сигнала)
 *   patient     один человек
 *   patientGroup группа пациентов — своя (чужая — 404, как у списка пациентов)
 *   from, to    период открытия случая, ГГГГ-ММ-ДД, обе границы включительно
 *   search      фамилия — по расшифрованным ФИО
 */
const listQuery = z
  .object({
    limit: queryInt(1, 100, 30),
    cursor: opt(z.string().max(200)),
    status: opt(z.enum(["open", "resolved", "all"])),
    all: opt(z.enum(["0", "1"])),
    group: opt(z.enum(["person", "case"])),
    severity: opt(z.enum(["moderate", "severe"])),
    assigned: opt(z.union([z.enum(["me", "none", "others"]), z.string().uuid()])),
    unit: opt(z.string().trim().min(1).max(120)),
    surveyId: opt(z.string().min(1).max(64)),
    patient: opt(z.string().uuid()),
    patientGroup: opt(z.string().uuid()),
    from: opt(queryDate),
    to: opt(queryDate),
    search: opt(z.string().trim().max(120)),
  })
  .strict();

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

/*
 * Время в ключе — с точностью до миллисекунды: ровно с такой оно уходит
 * клиенту в курсоре. Сравнение полного значения из базы (микросекунды у
 * записей, заведённых через now()) с усечённым из курсора выбрасывало бы
 * строки, попавшие между ними, — редкость, но молчаливая.
 */
const lastAlertMs = sql`date_trunc('milliseconds', ${alertCases.lastAlertAt})`;

/**
 * Просрочен ли случай — выражением в SQL, а не в приложении.
 *
 * Счётчик «прострочено N» считается по всей выборке, а не по загруженной
 * странице (прежде консоль считала его по тридцати строкам на экране — и на
 * сотнях случаев показывала число, не имеющее отношения к очереди). Пометка
 * на строке считается тем же выражением, чтобы число и пометки сходились.
 * Правило прежнее: минут с открытия (округлённо) не меньше порога методики.
 */
const overdueSql = sql<boolean>`(${alertCases.acknowledgedAt} is null
  and ${surveys.alertEscalateMinutes} is not null
  and round(extract(epoch from (now() - ${alertCases.openedAt})) / 60) >= ${surveys.alertEscalateMinutes})`;

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

type Grouping = AlertCasePage["grouping"];

/**
 * Курсор — «вид выборки + тяжесть + время последней тревоги + идентификатор».
 *
 * Идентификатор нужен даже при точном времени: у случаев, заведённых в одну
 * секунду, порядок между страницами разъехался бы и часть записей человек бы
 * не увидел вовсе. Вид выборки — потому что курсор очереди по людям и курсор
 * списка случаев указывают на разное; поданный не туда, он молча пропустил
 * бы часть строк.
 */
interface Cursor {
  rank: 0 | 1;
  at: string;
  id: string;
}
function encodeCursor(grouping: Grouping, c: Cursor): string {
  return Buffer.from(`${grouping === "person" ? "p" : "c"}|${c.rank}|${c.at}|${c.id}`).toString("base64url");
}
function decodeCursor(raw: string, grouping: Grouping): Cursor {
  const parts = Buffer.from(raw, "base64url").toString("utf8").split("|");
  const [mode, rank, at, id] = parts;
  const valid =
    parts.length === 4 &&
    mode === (grouping === "person" ? "p" : "c") &&
    (rank === "0" || rank === "1") &&
    !!at &&
    ISO_MS.test(at) &&
    !Number.isNaN(Date.parse(at)) &&
    !!id &&
    /^[A-Za-z0-9-]{1,64}$/.test(id);
  if (!valid) badRequestDetail("cursor: курсор повреждён или относится к другой выборке — начните список заново");
  return { rank: Number(rank) as 0 | 1, at: at!, id: id! };
}

/** Список идентификаторов для сырого SQL: drizzle внутри sql`` их не разложит. */
function sqlIds(ids: string[]): SQL {
  return sql`(${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

/** Метка времени из сырого SQL — в ISO с миллисекундами, как у timestampCol */
function isoSql(expr: SQL): SQL<string> {
  return sql<string>`to_char((${expr}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

function assignedFilter(value: string | undefined, me: string): SQL | undefined {
  if (!value) return undefined;
  if (value === "me") return eq(alertCases.assignedTo, me);
  if (value === "none") return isNull(alertCases.assignedTo);
  if (value === "others") return and(isNotNull(alertCases.assignedTo), ne(alertCases.assignedTo, me));
  return eq(alertCases.assignedTo, value);
}

const NO_FACETS: AlertCaseFacets = {
  total: 0,
  severity: { severe: 0, moderate: 0 },
  sections: { severe: 0, moderate: 0 },
  assigned: { me: 0, none: 0, others: 0 },
  overdue: 0,
  oldestOpenedAt: null,
};

/**
 * Очередь случаев.
 *
 * ═══ Группировка ═══
 *
 * Открытая очередь отдаётся строкой на ЧЕЛОВЕКА, а не на случай. Случай уже
 * собирает сигналы одного человека, но открытых случаев у человека бывает
 * несколько: в разных зонах видимости (см. attachCaseRow — у того, кто видит
 * обе группы, их два) и по правилу окна (сигнал через неделю после
 * неразобранного случая — новый эпизод). На сотнях неразобранных случаев это
 * ровно те люди, которые ждут дольше всех, — и они же раскатывались по
 * очереди несколькими строками на разных страницах: дежурный разбирал
 * свежий случай, не зная о старом. Строка человека стоит там, где стоял бы
 * его самый срочный случай, несёт число случаев и сигналов, самую раннюю
 * дату открытия и признак «хоть один просрочен»; сами случаи разбор
 * показывает рядом (`patient=` + `group=case`).
 *
 * Почему не по выраженности: выраженность и так первый ключ порядка, и
 * разделы «тяжкі / помірні» консоль рисует над строками по счётчикам ниже, —
 * а группировка по ней не убрала бы из очереди ни одного повтора человека.
 *
 * Разобранные и «все» — строкой на случай: там смотрят решения, а решение
 * принимается о случае. Просьба сгруппировать их по человеку — отказ, а не
 * молчаливая подмена: «ведущий случай» среди разобранных и открытых одного
 * человека выбирался бы произвольно.
 *
 * ═══ Счётчики ═══
 *
 * На первой странице — одним запросом по всей выборке, в тех же единицах,
 * что строки (люди или случаи). Счётчик варианта фильтра считается без
 * этого фильтра, но со всеми остальными: «Лише важкі · 12» — это ровно
 * столько строк, сколько покажет нажатие. Разделы — по выраженности самого
 * срочного случая строки, их сумма равна `total`.
 *
 * ═══ Поиск ═══
 *
 * ФИО зашифровано, LIKE по шифртексту ничего не найдёт, поэтому фамилия
 * ищется в приложении — но теперь до выборки, а не после. Прежде бралось
 * четыреста случаев и фильтровалось на месте: на очереди длиннее
 * четырёхсот человек из хвоста не находился вовсе, «конец списка»
 * появлялся посреди него, а общее число не считалось. Теперь
 * расшифровываются люди выборки (их сотни, а не сотни тысяч), найденные
 * становятся условием `user_id in (…)`, и курсор, счётчики и порядок
 * работают так же, как без поиска.
 */
alertCaseRoutes.get("/", async (c) => {
  // язык читателя: t() без него отдаёт украинский всегда
  const lang = langOf(c);
  const user = c.get("user");
  const q = parseQuery(c, listQuery);

  if (q.status && q.all && (q.all === "1") !== (q.status === "all")) {
    badRequestDetail("status: противоречит all — задайте что-то одно");
  }
  const status = q.status ?? (q.all === "1" ? "all" : "open");
  if (q.group === "person" && status !== "open") {
    badRequestDetail("group: по человеку группируется только открытая очередь");
  }
  const grouping: Grouping = q.group ?? (status === "open" ? "person" : "case");
  if (q.from && q.to && Date.parse(q.from) > Date.parse(q.to)) badRequest("err.periodReversed");
  const cursor = q.cursor ? decodeCursor(q.cursor, grouping) : null;
  if (q.patientGroup) await assertPatientGroupAccess(user, q.patientGroup);

  const firstPage = !cursor;
  const finish = async (body: AlertCasePage) => {
    await audit(c, {
      action: "alert.list",
      details: { returned: body.items.length, filters: { ...q, cursor: undefined, status, group: grouping } },
    });
    return c.json(body);
  };
  const nothing = (): AlertCasePage => ({
    items: [],
    nextCursor: null,
    ...(firstPage ? { total: 0, facets: NO_FACETS } : {}),
    grouping,
  });

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const surveyIds = scoped.map((s) => s.id);
  if (!surveyIds.length) return finish(nothing());

  /*
   * Область видимости — по методике, с которой случай начался.
   *
   * Так было не всегда: пока случай собирал сигналы разных зон, здесь стояло
   * «или хотя бы один сигнал в зоне» — и не помогало, потому что политика
   * строк (0029) держит случай за начальной методикой, и под боевой ролью
   * сотрудник чужой зоны случая не получал вовсе. Теперь случай живёт в
   * одной зоне (lib/alertCases.ts, миграция 0098), и начальная методика
   * говорит о зоне всё.
   */
  const base: SQL[] = [inArray(alertCases.surveyId, surveyIds)];
  if (status === "open") base.push(isNull(alertCases.acknowledgedAt));
  else if (status === "resolved") base.push(isNotNull(alertCases.acknowledgedAt));
  if (q.surveyId) {
    base.push(
      or(
        eq(alertCases.surveyId, q.surveyId),
        sql`exists (select 1 from risk_alerts ra where ra.case_id = ${alertCases.id} and ra.survey_id = ${q.surveyId})`,
      )!,
    );
  }
  if (q.unit) base.push(eq(users.unit, q.unit));
  if (q.patient) base.push(eq(alertCases.userId, q.patient));
  if (q.patientGroup) {
    base.push(
      sql`${alertCases.userId} in (select pgm.patient_id from patient_group_members pgm where pgm.group_id = ${q.patientGroup})`,
    );
  }
  /*
   * Период — по дате открытия, а не последнего сигнала: открытие у случая не
   * меняется, и «за вчерашнее дежурство» не расползается оттого, что у
   * человека сегодня пришёл новый сигнал. Верхняя граница включительно:
   * выбирают день, а не момент — как в аналитике и списке прохождений.
   *
   * Сутки — учреждения (lib/population.ts), а не пояса сессии базы. Прежде
   * `${q.from}::date` сравнивался с моментом в поясе сессии: на сервере он
   * UTC, и случай, открытый в час ночи по Киеву, попадал во «вчера» —
   * «за вчерашнее дежурство» показывало чужую ночь.
   */
  if (q.from) base.push(sql`${alertCases.openedAt} >= ${periodFrom(q.from)}`);
  if (q.to) base.push(sql`${alertCases.openedAt} < ${periodTo(q.to)}`);

  const needle = q.search?.toLowerCase() || undefined;
  if (needle) {
    const people = await db
      .selectDistinct({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        middleName: users.middleName,
        anonymous: users.anonymous,
        pseudonym: users.pseudonym,
      })
      .from(alertCases)
      .innerJoin(users, eq(users.id, alertCases.userId))
      .where(and(...base));
    const found = people.filter((p) => fullNameOf(p as never).toLowerCase().includes(needle)).map((p) => p.id);
    if (!found.length) return finish(nothing());
    base.push(inArray(alertCases.userId, found));
  }

  const severityPred = q.severity ? eq(alertCases.severity, q.severity) : undefined;
  const assignedPred = assignedFilter(q.assigned, user.id);
  const where = and(...base, severityPred, assignedPred)!;

  // считаются только сигналы по доступным методикам — столько же, сколько
  // будет показано ниже: число, не сходящееся со списком, хуже отсутствия
  const signalCountSql = sql<number>`(select count(*)::int from risk_alerts ra
    where ra.case_id = ${alertCases.id} and ra.survey_id in ${sqlIds(surveyIds)})`;

  const matched = sql`
    select ${alertCases.id} as id, ${alertCases.userId} as user_id, ${severityRank} as rank,
           ${lastAlertMs} as last_ms, ${alertCases.openedAt} as opened_at,
           ${overdueSql} as overdue, ${signalCountSql} as signals
    from ${alertCases}
    inner join ${surveys} on ${surveys.id} = ${alertCases.surveyId}
    inner join ${users} on ${users.id} = ${alertCases.userId}
    where ${where}`;
  const after = cursor
    ? sql`where (g.rank, g.last_ms, g.id) < (${cursor.rank}, ${cursor.at}::timestamptz, ${cursor.id})`
    : sql``;
  const grouped =
    grouping === "person"
      ? sql`
        select distinct on (m.user_id)
               m.id, m.user_id, m.rank, m.last_ms,
               (count(*) over w)::int as cases,
               bool_or(m.overdue) over w as any_overdue,
               min(m.opened_at) over w as oldest_opened,
               (sum(m.signals) over w)::int as signals
        from m
        window w as (partition by m.user_id)
        order by m.user_id, m.rank desc, m.last_ms desc, m.id desc`
      : sql`
        select m.id, m.user_id, m.rank, m.last_ms, 1 as cases, m.overdue as any_overdue,
               m.opened_at as oldest_opened, m.signals
        from m`;

  const rows = (await db.execute(sql`
    with m as (${matched}), g as (${grouped})
    select g.id, g.rank, ${isoSql(sql`g.last_ms`)} as last_at, g.cases, g.any_overdue,
           ${isoSql(sql`g.oldest_opened`)} as oldest_opened, g.signals
    from g
    ${after}
    order by g.rank desc, g.last_ms desc, g.id desc
    limit ${q.limit + 1}
  `)) as unknown as {
    id: string;
    rank: number;
    last_at: string;
    cases: number;
    any_overdue: boolean;
    oldest_opened: string;
    signals: number;
  }[];

  const pageRows = rows.slice(0, q.limit);
  const hasMore = rows.length > q.limit;
  const pageIds = pageRows.map((r) => r.id);

  const details = pageIds.length
    ? await db
        .select({
          c: alertCases,
          surveyTitle: surveys.title,
          overdue: overdueSql,
          unit: users.unit,
          // имена полей ровно как ждёт fullNameOf: он же расшифровывает и умеет
          // про псевдонимы, дублировать эту логику здесь незачем
          firstName: users.firstName,
          lastName: users.lastName,
          middleName: users.middleName,
          anonymous: users.anonymous,
          pseudonym: users.pseudonym,
          signalCount: signalCountSql,
        })
        .from(alertCases)
        .innerJoin(surveys, eq(surveys.id, alertCases.surveyId))
        .innerJoin(users, eq(users.id, alertCases.userId))
        .where(inArray(alertCases.id, pageIds))
    : [];
  const byId = new Map(details.map((d) => [d.c.id, d]));

  // сигналы одним запросом на страницу, а не по запросу на случай
  const signalsByCase = new Map<string, AlertSignal[]>();
  if (pageIds.length) {
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
      .where(and(inArray(riskAlerts.caseId, pageIds), inArray(riskAlerts.surveyId, surveyIds)))
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
    ...new Set(details.flatMap((r) => [r.c.assignedTo, r.c.acknowledgedBy]).filter((x): x is string => !!x)),
  ];
  const staffNames = new Map<string, string>();
  if (staffIds.length) {
    for (const u of await db.select().from(users).where(inArray(users.id, staffIds))) {
      staffNames.set(u.id, fullNameOf(u));
    }
  }

  const now = Date.now();
  /*
   * Порядок задан в ORDER BY и здесь не переставляется: строки идут ровно в
   * том порядке, в каком их отдала выборка страницы. Пересортировка после
   * выборки как раз и создавала видимость упорядоченной очереди: она
   * наводила порядок среди тридцати уже выбранных случаев и ничего не могла
   * сделать с тридцать первым.
   */
  const items: AlertCase[] = pageRows.flatMap((g) => {
    const r = byId.get(g.id);
    if (!r) return [];
    /*
     * Минуты — на чтении: для подписи «сколько ждёт» точность до минуты, а
     * пометка «просрочен» пришла из SQL тем же выражением, что и счётчик.
     */
    const openedMs = r.c.acknowledgedAt
      ? new Date(r.c.acknowledgedAt).getTime() - new Date(r.c.openedAt).getTime()
      : now - new Date(r.c.openedAt).getTime();
    const minutesOpen = Math.max(0, Math.round(openedMs / 60_000));

    return [
      {
        id: r.c.id,
        userId: r.c.userId,
        userName: fullNameOf(r as never),
        unit: r.unit,
        surveyId: r.c.surveyId,
        surveyTitle: t(r.surveyTitle as never, lang),
        severity: r.c.severity,
        openedAt: r.c.openedAt,
        lastAlertAt: r.c.lastAlertAt,
        signalCount: Number(r.signalCount ?? 0),
        signals: signalsByCase.get(r.c.id) ?? [],
        minutesOpen,
        overdue: !!r.overdue,
        assignedTo: r.c.assignedTo,
        assignedToName: r.c.assignedTo ? (staffNames.get(r.c.assignedTo) ?? null) : null,
        acknowledgedBy: r.c.acknowledgedBy,
        acknowledgedByName: r.c.acknowledgedBy ? (staffNames.get(r.c.acknowledgedBy) ?? null) : null,
        acknowledgedAt: r.c.acknowledgedAt,
        note: r.c.note,
        outcome: r.c.outcome,
        mergedFromLegacy: r.c.mergedFromLegacy,
        ...(grouping === "person"
          ? {
              group: {
                cases: Number(g.cases),
                signals: Number(g.signals),
                overdue: !!g.any_overdue,
                oldestOpenedAt: g.oldest_opened,
              },
            }
          : {}),
      },
    ];
  });

  // счётчики — только на первой странице: на остальных они те же
  let facets: AlertCaseFacets | undefined;
  if (firstPage) {
    const unitOf = grouping === "person" ? sql`${alertCases.userId}` : sql`${alertCases.id}`;
    const sevOk = severityPred ?? sql`true`;
    const asOk = assignedPred ?? sql`true`;
    const [f] = (await db.execute(sql`
      select
        count(distinct ${unitOf}) filter (where ${sevOk} and ${asOk})::int as total,
        count(distinct ${unitOf}) filter (where ${asOk} and ${alertCases.severity} = 'severe')::int as sev_severe,
        count(distinct ${unitOf}) filter (where ${asOk} and ${alertCases.severity} = 'moderate')::int as sev_moderate,
        count(distinct ${unitOf}) filter (where ${sevOk} and ${asOk} and ${alertCases.severity} = 'severe')::int as sec_severe,
        count(distinct ${unitOf}) filter (where ${sevOk} and ${alertCases.assignedTo} = ${user.id})::int as as_me,
        count(distinct ${unitOf}) filter (where ${sevOk} and ${alertCases.assignedTo} is null)::int as as_none,
        count(distinct ${unitOf}) filter (where ${sevOk} and ${alertCases.assignedTo} <> ${user.id})::int as as_others,
        count(distinct ${unitOf}) filter (where ${sevOk} and ${asOk} and ${overdueSql})::int as overdue,
        ${isoSql(sql`min(${alertCases.openedAt}) filter (where ${sevOk} and ${asOk} and ${alertCases.acknowledgedAt} is null)`)} as oldest
      from ${alertCases}
      inner join ${surveys} on ${surveys.id} = ${alertCases.surveyId}
      inner join ${users} on ${users.id} = ${alertCases.userId}
      where ${and(...base)}
    `)) as unknown as {
      total: number;
      sev_severe: number;
      sev_moderate: number;
      sec_severe: number;
      as_me: number;
      as_none: number;
      as_others: number;
      overdue: number;
      oldest: string | null;
    }[];
    const total = Number(f?.total ?? 0);
    /*
     * Раздел строки — по её самому срочному случаю, поэтому «тяжкі» — те, у
     * кого хоть один тяжёлый случай в выборке, а «помірні» — остальные.
     * Считать «помірні» тем же фильтром, что вариант фильтра, нельзя: человек
     * с тяжёлым и умеренным случаем попал бы в оба раздела, а стоит в одном.
     */
    const sectionSevere = Number(f?.sec_severe ?? 0);
    facets = {
      total,
      severity: { severe: Number(f?.sev_severe ?? 0), moderate: Number(f?.sev_moderate ?? 0) },
      sections: { severe: sectionSevere, moderate: total - sectionSevere },
      assigned: { me: Number(f?.as_me ?? 0), none: Number(f?.as_none ?? 0), others: Number(f?.as_others ?? 0) },
      overdue: Number(f?.overdue ?? 0),
      oldestOpenedAt: f?.oldest ?? null,
    };
  }

  const last = pageRows[pageRows.length - 1];
  return finish({
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor(grouping, { rank: last.rank === 1 ? 1 : 0, at: last.last_at, id: last.id })
        : null,
    ...(facets ? { total: facets.total, facets } : {}),
    grouping,
  });
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
    // тем же правилом, что движок подсчёта (bandFor): полуинтервал через щель точности границ
    const band =
      score && score.value !== null
        ? (bandFor(
            bandRows.filter((b) => b.scaleId === s.a.scaleId),
            score.value,
          ) ?? undefined)
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
  // 409, а не 400: запрос правильный, не сходится состояние случая
  if (row.acknowledgedAt) conflict("err.caseAlreadyHandled");

  const body = await c.req.json().catch(() => ({}));
  const release = body?.release === true;

  if (!release && row.assignedTo && row.assignedTo !== user.id) {
    conflict("err.caseTakenByOther");
  }

  /*
   * Проверка выше — для внятного ответа, а решает условие в самом операторе.
   *
   * Прежде «никем не взят» проверялось чтением, а запись шла безусловно: два
   * дежурных, нажавших «взять» разом, оба читали пустое поле, оба получали
   * 200 и оба садились разбирать одного человека — ровно то, от чего
   * пометка «взял» и заводилась. Теперь второй оператор перепроверяет строку
   * после первого (READ COMMITTED перечитывает её, дождавшись фиксации) и
   * не находит её свободной. Отпустить можно только свой случай: чужую
   * отметку снимает не соседняя кнопка, а тот, кто её поставил.
   */
  const [updated] = await db
    .update(alertCases)
    .set(
      release
        ? { assignedTo: null, assignedAt: null }
        : { assignedTo: user.id, assignedAt: new Date().toISOString() },
    )
    .where(
      and(
        eq(alertCases.id, row.id),
        isNull(alertCases.acknowledgedAt),
        release
          ? or(eq(alertCases.assignedTo, user.id), isNull(alertCases.assignedTo))
          : or(isNull(alertCases.assignedTo), eq(alertCases.assignedTo, user.id)),
      ),
    )
    .returning();
  if (!updated) {
    const now = await db.query.alertCases.findFirst({ where: eq(alertCases.id, row.id) });
    conflict(now?.acknowledgedAt ? "err.caseAlreadyHandled" : "err.caseTakenByOther");
  }

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
  /*
   * Какой случай человек видел, когда решал: время его последнего сигнала.
   *
   * Необязательно (мобильный клиент его не шлёт), но консоль шлёт всегда.
   * Без него решение ложилось на всё, что лежит в случае к моменту записи, —
   * и сигнал, пришедший, пока дежурный читал основание, закрывался исходом,
   * принятым без него. Кривое значение — отказ, а не «проверку не делаем»:
   * молча пропущенная проверка и есть то, от чего она стоит.
   */
  const seenRaw: unknown = body?.seenLastAlertAt;
  if (seenRaw !== undefined && seenRaw !== null && (typeof seenRaw !== "string" || Number.isNaN(Date.parse(seenRaw)))) {
    badRequestDetail("seenLastAlertAt: ожидается метка времени ISO");
  }
  const seen = typeof seenRaw === "string" ? seenRaw : null;

  await db.transaction(async (tx) => {
    /*
     * Решение — условным оператором, а не «прочитали, потом записали».
     *
     * «Ещё не разобран» и «новых сигналов не было» проверяются в самом
     * UPDATE: если сигнал дописывается в эту минуту, оператор ждёт его
     * фиксации и перепроверяет строку (см. attachCaseRow — дополнение тоже
     * условное). Второе решение о разобранном случае тоже отказ: прежде оно
     * молча затирало первое вместе с тем, кто и когда его принял.
     * Время сравнивается с точностью до миллисекунды — с той, с какой оно
     * уходит клиенту.
     */
    const done = await tx
      .update(alertCases)
      .set({ acknowledgedBy: user.id, acknowledgedAt: at, note, outcome })
      .where(
        and(
          eq(alertCases.id, row.id),
          isNull(alertCases.acknowledgedAt),
          seen ? sql`date_trunc('milliseconds', ${alertCases.lastAlertAt}) <= ${seen}::timestamptz` : undefined,
        ),
      )
      .returning({ id: alertCases.id });
    if (!done.length) {
      const now = await tx.query.alertCases.findFirst({ where: eq(alertCases.id, row.id) });
      conflict(now?.acknowledgedAt ? "err.caseAlreadyHandled" : "err.caseChanged");
    }

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
