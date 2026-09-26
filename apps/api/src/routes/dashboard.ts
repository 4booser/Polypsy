import { Hono } from "hono";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { t, type ConditionDomain, type ConditionsResult, type Severity } from "@quizzy/shared";
import { db } from "../db";
import { surveys } from "../db/schema";
import { env } from "../env";
import { audit } from "../lib/audit";
import {
  CONDITION_DOMAINS,
  overallFromCounts,
  summarizeAggregate,
  type DomainAggregate,
} from "../lib/conditions";
import { langOf, parseQuery } from "../lib/http";
import { accessiblePatientIds, surveyScopeFilter } from "../lib/scope";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

/**
 * Показатели стартового экрана, которых не было в общей аналитике.
 *
 * Отдельный раздел, а не ещё один маршрут `/api/analytics/*`: сводка по
 * методикам отвечает «сколько прошли», а этот — «в каком состоянии люди».
 * Право то же (`analytics.read`), и по той же причине, что у ряда по
 * неделям: наружу уходят обезличенные счётчики и средние, ни одного имени и
 * ни одного идентификатора прохождения.
 */
export const dashboardRoutes = new Hono<AppEnv>();

dashboardRoutes.use("*", requireAuth, requireStaff, requirePermission("analytics.read"));

const conditionsQuery = z.object({
  /*
   * Период — днями, а не «месяц/квартал»: у месяца разная длина, и доля за
   * «февраль» и «март» считалась бы по разным окнам. Экран спрашивает 30 и
   * 90; границы шире — для отчётов, которые захотят того же.
   */
  days: z.coerce.number().int().min(7).max(365).default(90),
});

const EMPTY_SPREAD = {
  banded: 0,
  clinical: { count: null, percent: null },
  bands: { none: 0, mild: 0, moderate: 0, severe: 0 },
} as const;

/**
 * Состояние пациентов по направлениям: депрессия, тревога, стресс, ПТСР,
 * благополучие, выгорание, алкоголь (см. lib/conditions.ts — почему так).
 *
 * Видимость — двумя поясами сразу: методики из зоны читателя
 * (surveyScopeFilter) и люди из его зоны (accessiblePatientIds). Первого
 * мало: заведующий видит методику группы, но человек мог прийти к ней по
 * разбитому стеклу чужого сотрудника — такие замеры в его сводку не идут.
 *
 * Анонимные прохождения (user_id пуст) не считаются: «последний замер
 * человека» у них определить нельзя, и каждый анонимный бланк считался бы
 * отдельным человеком.
 */
dashboardRoutes.get("/conditions", async (c) => {
  const { days } = parseQuery(c, conditionsQuery);
  const user = c.get("user");
  const lang = langOf(c);
  const tz = env.institutionTz;

  const scope = await surveyScopeFilter(user);
  const scoped = await db
    .select({ id: surveys.id, title: surveys.title, catalogKey: surveys.catalogKey })
    .from(surveys)
    .where(scope);
  const patients = await accessiblePatientIds(user);

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const empty = (): ConditionsResult => ({
    days,
    since,
    domains: [],
    empty: CONDITION_DOMAINS.map((d) => d.key),
    overall: { people: 0, spread: { ...EMPTY_SPREAD } },
  });

  if (!scoped.length || (patients && patients.size === 0)) {
    const result = empty();
    await audit(c, { action: "dashboard.conditions", details: { days, domains: 0 } });
    return c.json(result);
  }

  const surveyIn = sql`r.survey_id in (${sql.join(scoped.map((s) => sql`${s.id}`), sql`, `)})`;
  /* зона по людям: null — без ограничений (суперадмин) */
  const peopleIn: SQL = patients
    ? sql`and r.user_id in (${sql.join([...patients].map((id) => sql`${id}`), sql`, `)})`
    : sql``;
  /*
   * Состав направлений — таблицей VALUES прямо в запросе: направление,
   * источник и его место в списке. Место нужно для той же ничьей, что
   * решает сводка (lib/conditions.ts, summarizeAggregate), а типы проставлены
   * явно — без них параметры VALUES приходят текстом, и «10» оказалось бы
   * меньше «2».
   */
  const domainSources = sql.join(
    CONDITION_DOMAINS.flatMap((d) =>
      d.sources.map((s, i) => sql`(${d.key}::text, ${s.catalogKey}::text, ${s.code}::text, ${i}::int)`),
    ),
    sql`, `,
  );

  /*
   * Последний замер каждого человека по каждой шкале — `distinct on` в базе,
   * и там же свёртка до счётчиков.
   *
   * Прежде сюда выбиралась строка на человека и шкалу, а раскладка, число
   * людей и средние складывались в приложении: на экране, который открывают
   * при каждом входе, это тысячи строк в память ради семи раскладок и семи
   * средних. Теперь база отдаёт три вида строк, по несколько на направление:
   *
   *   people — сколько людей замерено направлением;
   *   band   — раскладка по последнему замеру С ПОЛОСОЙ каждого человека
   *            (при равном времени — первый по методике и шкале, как и
   *            прежде: строки шли в этом порядке, и брался первый);
   *   source — по каждой шкале-источнику: людей и несглаженное среднее.
   *
   * Одним запросом, а не тремя: последний замер — самая дорогая часть, и
   * считать его трижды значило бы втрое платить за экономию памяти.
   *
   * «Последний» доопределён идентификатором прохождения: два замера одной
   * шкалы одного человека с одинаковым временем (групповое обследование,
   * повтор сдачи) прежде разрешались как придётся — базе всё равно, какую из
   * равных строк оставить в DISTINCT ON, и одна и та же сводка могла от
   * запроса к запросу называть разную ступень. Нашлось сверкой со старым
   * подсчётом: оба «правильных» ответа расходились именно на таких парах.
   */
  const aggRows = [
    ...(await db.execute<{
      kind: "people" | "band" | "source";
      domain: ConditionDomain;
      survey_id: string | null;
      code: string | null;
      ord: number | null;
      severity: Severity | null;
      n: number;
      mean: number | null;
    } & Record<string, unknown>>(sql`
      with src(domain, catalog_key, code, ord) as (values ${domainSources}),
      latest as (
        select distinct on (r.user_id, r.survey_id, sc.code)
          r.user_id, r.survey_id, s.catalog_key, sc.code, rs.severity, rs.percent, r.submitted_at as at
        from responses r
        join surveys s on s.id = r.survey_id
        join response_scores rs on rs.response_id = r.id
        join scales sc on sc.id = rs.scale_id
        where r.status = 'completed'
          and r.user_id is not null
          and r.submitted_at is not null
          and r.submitted_at >= ${since}
          and ${surveyIn}
          ${peopleIn}
          and (s.catalog_key, sc.code) in (select catalog_key, code from src)
        order by r.user_id, r.survey_id, sc.code, r.submitted_at desc, r.id desc
      ),
      tagged as (
        select src.domain, src.ord, l.user_id, l.survey_id, l.code, l.severity, l.percent, l.at
        from latest l
        join src on src.catalog_key = l.catalog_key and src.code = l.code
      ),
      banded as (
        select distinct on (domain, user_id) domain, user_id, severity
        from tagged
        where severity is not null
        order by domain, user_id, at desc, survey_id, code
      )
      select 'people' as kind, domain, null::text as survey_id, null::text as code, null::int as ord,
             null::text as severity, count(distinct user_id)::int as n, null::float8 as mean
      from tagged group by domain
      union all
      select 'band', domain, null, null, null, severity, count(*)::int, null
      from banded group by domain, severity
      union all
      select 'source', domain, survey_id, code, min(ord), null, count(*)::int, avg(percent)::float8
      from tagged group by domain, survey_id, code
    `)),
  ];

  const aggregates = new Map<ConditionDomain, DomainAggregate>(
    CONDITION_DOMAINS.map((d) => [d.key, { people: 0, counts: { none: 0, mild: 0, moderate: 0, severe: 0 }, sources: [] }]),
  );
  for (const r of aggRows) {
    const agg = aggregates.get(r.domain);
    if (!agg) continue;
    if (r.kind === "people") agg.people = Number(r.n);
    else if (r.kind === "band" && r.severity) agg.counts[r.severity] = Number(r.n);
    else if (r.kind === "source" && r.survey_id && r.code) {
      agg.sources.push({
        surveyId: String(r.survey_id),
        code: String(r.code),
        order: Number(r.ord ?? 99),
        people: Number(r.n),
        mean: r.mean === null ? null : Number(r.mean),
      });
    }
  }

  /*
   * Ход по неделям — одним запросом для всех шкал, по которым есть замеры:
   * какая из них окажется основной, решает арифметика направления, а второй
   * поход в базу на каждое направление стоил бы семь запросов вместо одного.
   * Внутри недели человек — один раз, последним замером.
   *
   * Неделя считается один раз в подзапросе: в DISTINCT ON и в ORDER BY одно и
   * то же выражение с часовым поясом стало бы двумя разными параметрами, и
   * база сочла бы их разными выражениями.
   */
  const measuredPairs = [
    ...new Set([...aggregates.values()].flatMap((a) => a.sources.map((s) => `${s.surveyId}\u0000${s.code}`))),
  ].map((k) => k.split("\u0000"));
  const weekRows = measuredPairs.length
    ? [
        ...(await db.execute<{ survey_id: string; code: string; week: string; n: number; mean: number } & Record<string, unknown>>(sql`
          with base as (
            select r.user_id, r.survey_id, sc.code, rs.percent, r.submitted_at,
                   date_trunc('week', r.submitted_at at time zone ${tz}) as week
            from responses r
            join response_scores rs on rs.response_id = r.id
            join scales sc on sc.id = rs.scale_id
            where r.status = 'completed'
              and r.user_id is not null
              and r.submitted_at is not null
              and r.submitted_at >= ${since}
              and ${surveyIn}
              ${peopleIn}
              and (r.survey_id, sc.code) in (${sql.join(measuredPairs.map(([id, code]) => sql`(${id}, ${code})`), sql`, `)})
          ),
          latest as (
            select distinct on (user_id, survey_id, code, week) survey_id, code, week, percent
            from base
            order by user_id, survey_id, code, week, submitted_at desc
          )
          select survey_id, code, to_char(week, 'YYYY-MM-DD') as week, count(*)::int as n, avg(percent)::float8 as mean
          from latest
          group by 1, 2, 3
        `)),
      ]
    : [];

  /*
   * Недели периода — все подряд, от недели начала до текущей: пропущенная
   * неделя в ряду читалась бы как «ничего не изменилось», а там не было
   * замеров. Пустая приходит с null и рисуется разрывом, а не нулём.
   */
  const spanRows = [
    ...(await db.execute<{ week: string } & Record<string, unknown>>(sql`
      select to_char(w, 'YYYY-MM-DD') as week
      from generate_series(
        date_trunc('week', ${since}::timestamptz at time zone ${tz}),
        date_trunc('week', now() at time zone ${tz}),
        interval '1 week'
      ) as w
    `)),
  ].map((r) => String(r.week));

  const weekly = (surveyId: string, code: string) => {
    const own = new Map(
      weekRows
        .filter((w) => String(w.survey_id) === surveyId && String(w.code) === code)
        .map((w) => [String(w.week), { n: Number(w.n), mean: Number(w.mean) }]),
    );
    return spanRows.map((week) => {
      const hit = own.get(week);
      return { week, n: hit?.n ?? 0, mean: hit ? hit.mean : null };
    });
  };

  const titles = new Map(scoped.map((s) => [s.id, t(s.title as never, lang)]));
  const titleOf = (id: string) => titles.get(id) || "—";

  const summaries = CONDITION_DOMAINS.map((def) =>
    summarizeAggregate(def, aggregates.get(def.key)!, { titleOf, weekly }),
  );
  const present = summaries.filter((s) => s.sources.length > 0);
  const missing: ConditionDomain[] = summaries.filter((s) => s.sources.length === 0).map((s) => s.domain);

  /*
   * «Кто где сейчас» — по всем клиническим шкалам всех методик зоны, не только
   * по направлениям: человек с тяжёлым результатом по методике вне каталога
   * тоже тяжёлый. Шкалы достоверности не участвуют — их полоса говорит о
   * протоколе, а не о человеке.
   *
   * Счёт — в базе: прежде сюда приходила строка на каждого человека зоны
   * ради четырёх чисел. Строка с worst = null — люди без единой полосы: они
   * входят в общее число, но не в раскладку.
   */
  const worstRows = await db.execute<{ worst: number | null; n: number } & Record<string, unknown>>(sql`
    with latest as (
      select distinct on (r.user_id, r.survey_id, sc.code)
        r.user_id, rs.severity
      from responses r
      join response_scores rs on rs.response_id = r.id
      join scales sc on sc.id = rs.scale_id
      where r.status = 'completed'
        and r.user_id is not null
        and r.submitted_at is not null
        and r.submitted_at >= ${since}
        and sc.kind = 'clinical'
        and ${surveyIn}
        ${peopleIn}
      order by r.user_id, r.survey_id, sc.code, r.submitted_at desc, r.id desc
    ),
    per_user as (
      select user_id,
             max(case severity when 'severe' then 4 when 'moderate' then 3 when 'mild' then 2 when 'none' then 1 end) as worst
      from latest
      group by user_id
    )
    select worst, count(*)::int as n from per_user group by worst
  `);
  const LEVEL: Record<number, Severity> = { 1: "none", 2: "mild", 3: "moderate", 4: "severe" };
  const worstCounts: Record<Severity, number> = { none: 0, mild: 0, moderate: 0, severe: 0 };
  let overallPeople = 0;
  for (const r of worstRows) {
    overallPeople += Number(r.n);
    const level = r.worst === null ? undefined : LEVEL[Number(r.worst)];
    if (level) worstCounts[level] += Number(r.n);
  }
  const overall = overallFromCounts(overallPeople, worstCounts);

  const result: ConditionsResult = { days, since, domains: present, empty: missing, overall };

  await audit(c, { action: "dashboard.conditions", details: { days, domains: present.length } });
  return c.json(result);
});
