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
  allSources,
  overallSpread,
  summarizeDomain,
  type Measurement,
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
  const pairs = sql.join(
    allSources().map((s) => sql`(${s.catalogKey}, ${s.code})`),
    sql`, `,
  );

  /*
   * Последний замер каждого человека по каждой шкале — `distinct on` в базе.
   * Выбирать все замеры за квартал в память ради последнего значило бы
   * расти линейно на экране, который открывают при каждом входе.
   */
  const measured = await db.execute<{
    user_id: string;
    survey_id: string;
    catalog_key: string | null;
    code: string;
    severity: Severity | null;
    percent: number;
    at: string;
  } & Record<string, unknown>>(sql`
    select distinct on (r.user_id, r.survey_id, sc.code)
      r.user_id, r.survey_id, s.catalog_key, sc.code, rs.severity,
      rs.percent::float8 as percent, r.submitted_at as at
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
      and (s.catalog_key, sc.code) in (${pairs})
    order by r.user_id, r.survey_id, sc.code, r.submitted_at desc
  `);

  const rows: Measurement[] = [...measured].map((r) => ({
    userId: String(r.user_id),
    surveyId: String(r.survey_id),
    catalogKey: r.catalog_key ? String(r.catalog_key) : null,
    code: String(r.code),
    severity: (r.severity ?? null) as Severity | null,
    percent: Number(r.percent),
    at: new Date(String(r.at)).toISOString(),
  }));

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
  const measuredPairs = [...new Set(rows.map((r) => `${r.surveyId}\u0000${r.code}`))].map((k) => k.split("\u0000"));
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

  const summaries = CONDITION_DOMAINS.map((def) => summarizeDomain(def, { rows, titleOf, weekly }));
  const present = summaries.filter((s) => s.sources.length > 0);
  const missing: ConditionDomain[] = summaries.filter((s) => s.sources.length === 0).map((s) => s.domain);

  /*
   * «Кто где сейчас» — по всем клиническим шкалам всех методик зоны, не только
   * по направлениям: человек с тяжёлым результатом по методике вне каталога
   * тоже тяжёлый. Шкалы достоверности не участвуют — их полоса говорит о
   * протоколе, а не о человеке.
   */
  const worstRows = await db.execute<{ user_id: string; worst: number | null } & Record<string, unknown>>(sql`
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
      order by r.user_id, r.survey_id, sc.code, r.submitted_at desc
    )
    select user_id,
           max(case severity when 'severe' then 4 when 'moderate' then 3 when 'mild' then 2 when 'none' then 1 end) as worst
    from latest
    group by user_id
  `);
  const LEVEL: Record<number, Severity> = { 1: "none", 2: "mild", 3: "moderate", 4: "severe" };
  const overall = overallSpread([...worstRows].map((r) => (r.worst === null ? null : (LEVEL[Number(r.worst)] ?? null))));

  const result: ConditionsResult = { days, since, domains: present, empty: missing, overall };

  await audit(c, { action: "dashboard.conditions", details: { days, domains: present.length } });
  return c.json(result);
});
