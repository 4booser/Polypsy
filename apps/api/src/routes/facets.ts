import { SMALL_CELL_FLOOR } from "../lib/privacy";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { facetQuery } from "@quizzy/shared";
import { db } from "../db";
import { audit } from "../lib/audit";
import { notFound, parseQuery } from "../lib/http";
import { percent, round } from "../lib/stats";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";

export const facetRoutes = new Hono<AppEnv>();

/*
 * Право вместо «просто персонал». requireStaff остаётся первым: оно отвечает
 * на другой вопрос — сотрудник ли это вообще, — и снимать его значило бы
 * отдать проверку класса учётной записи проверке права.
 *
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
facetRoutes.use("*", requireAuth, requireStaff, requirePermission("analytics.read"));

/** П-1: страта меньше пяти наружу не выходит */
/*
 * Порог берётся из общего места, а не объявляется здесь заново.
 *
 * Своя копия числа означает, что изменить порог в одном месте и забыть о
 * другом — вопрос времени, а расходятся такие копии молча. Ровно об этом
 * предупреждает докстрока в lib/privacy.ts.
 */

/**
 * Стратифицированные срезы аналитики (5.1) поверх витрины фактов.
 *
 * Средний балл «по больнице» скрывает обе группы сразу: тревожность женщин
 * 25–34 и мужчин 45+ — разные распределения. Здесь каждая метрика режется
 * по выбранному фасету, а ячейки меньше порога подавляются: это стандарт
 * медицинской статистики против реидентификации, а не перестраховка.
 */
facetRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("err.surveyNotFound");

  const { facet } = parseQuery(c, facetQuery);
  const expr = {
    sex: sql`coalesce(respondent_sex, '—')`,
    age: sql`coalesce(respondent_age_band, '—')`,
    sexAge: sql`coalesce(respondent_sex, '—') || ' · ' || coalesce(respondent_age_band, '—')`,
    lang: sql`coalesce(lang, '—')`,
    unit: sql`coalesce(unit, '—')`,
  }[facet];

  const rows = await db.execute(sql`
    select
      scale_code,
      ${expr} as stratum,
      count(*)::int              as n,
      avg(value)                 as mean,
      stddev_samp(value)         as sd,
      percentile_cont(0.5) within group (order by value) as median,
      count(*) filter (where is_risk)::int as risk
    from response_facts
    where survey_id = ${surveyId}
      and status = 'completed'
      and scale_kind = 'clinical'
    group by scale_code, ${expr}
    order by scale_code, ${expr}`);

  type Row = {
    scale_code: string;
    stratum: string;
    n: number;
    mean: number | null;
    sd: number | null;
    median: number | null;
    risk: number;
  };

  const byScale = new Map<string, Row[]>();
  for (const raw of rows as unknown as Row[]) {
    const list = byScale.get(raw.scale_code) ?? [];
    list.push(raw);
    byScale.set(raw.scale_code, list);
  }

  const scales = survey.scales
    .filter((s) => s.kind === "clinical")
    .map((scale) => {
      const list = byScale.get(scale.code) ?? [];
      const suppressed = list.filter((r) => Number(r.n) < SMALL_CELL_FLOOR).length;
      return {
        code: scale.code,
        title: scale.title,
        normalization: scale.normalization,
        suppressedStrata: suppressed,
        strata: list
          .filter((r) => Number(r.n) >= SMALL_CELL_FLOOR)
          .map((r) => ({
            stratum: r.stratum,
            n: Number(r.n),
            mean: r.mean === null ? null : round(Number(r.mean), 2),
            sd: r.sd === null ? null : round(Number(r.sd), 2),
            median: r.median === null ? null : round(Number(r.median), 2),
            /*
             * Доля риска скрывается, если по ней восстанавливается человек.
             *
             * Порог применялся к размеру страты, но не к числу людей в
             * риске внутри неё: страта из пяти с одним в риске отдавала
             * riskShare 20 — и этот один вычислялся точно. Скрывать надо и
             * обратный край: «четверо из пяти» так же однозначно называет
             * пятого.
             */
            riskShare:
              Number(r.risk) < SMALL_CELL_FLOOR ||
              Number(r.n) - Number(r.risk) < SMALL_CELL_FLOOR
                ? null
                : percent(Number(r.risk), Number(r.n)),
          })),
      };
    })
    .filter((s) => s.strata.length > 0 || s.suppressedStrata > 0);

  await audit(c, {
    action: "analytics.facets",
    resourceType: "survey",
    resourceId: surveyId,
    details: { facet, scales: scales.length },
  });

  return c.json({ surveyId, title: survey.title, facet, smallCellFloor: SMALL_CELL_FLOOR, scales });
});
