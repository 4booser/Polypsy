import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import {
  ageAt,
  directStandardize,
  cohortQuery,
  type CohortBy,
  type ScaleNormalization,
  type ComparisonResult,
  type CorrelationMatrix,
  type Severity,
} from "@quizzy/shared";
import { db } from "../db";
import { responseScores, responses, users } from "../db/schema";
import { audit } from "../lib/audit";
import { decryptField } from "../lib/crypto";
import { notFound, parseQuery } from "../lib/http";
import { average, median, pearson, percent, round, variance } from "../lib/stats";
import { assertSurveyAccess } from "../lib/scope";
import { getSurvey } from "../lib/surveys";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const comparisonRoutes = new Hono<AppEnv>();

comparisonRoutes.use("*", requireAuth, requireStaff);

/**
 * Минимальный размер когорты.
 *
 * Порогов здесь два, и они про разное: статистический — сколько нужно, чтобы
 * среднее что-то значило; приватный — с какого размера группа перестаёт
 * указывать на конкретного человека. Побеждает строгий.
 *
 * Раньше когорты показывались от трёх наблюдений, тогда как фасеты и отчёт по
 * подразделению подавляют ячейки меньше пяти. В маленькой роте когорта из
 * трёх с минимумом и максимумом — это почти поимённые данные, а правило
 * учреждения о малых ячейках при этом формально соблюдалось в двух местах из
 * трёх.
 */
const MIN_COHORT = 5;
/** Минимум наблюдений для коэффициента корреляции */
const MIN_CORRELATION_SAMPLE = 10;

const AGE_GROUPS: [string, number, number][] = [
  ["до 25", 0, 24],
  ["25–34", 25, 34],
  ["35–44", 35, 44],
  ["45 и старше", 45, 200],
];

/**
 * Сравнение когорт по одной методике.
 *
 * Когорты режутся по полю паспортной части. Прохождения, у которых поле не
 * заполнено, не попадают никуда и считаются отдельно — молча растворять их
 * в «прочих» значило бы искажать сравнение.
 */
comparisonRoutes.get("/surveys/:id", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);

  const { by } = parseQuery(c, cohortQuery);
  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("Методика не найдена");

  const rows = await db
    .select({ response: responses, user: users })
    .from(responses)
    .leftJoin(users, eq(users.id, responses.userId))
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")));

  const cohortOf = (r: (typeof rows)[number]): string | null => {
    const u = r.user;
    if (!u) return null;
    switch (by) {
      case "unit":
        return u.unit?.trim() || null;
      case "rank":
        return u.rank?.trim() || null;
      case "sex":
        return u.sex ? (u.sex === "male" ? "Мужчины" : "Женщины") : null;
      case "ageGroup": {
        const age = ageAt(decryptField(u.birthDate), r.response.submittedAt);
        if (age === null) return null;
        return AGE_GROUPS.find(([, lo, hi]) => age >= lo && age <= hi)?.[0] ?? null;
      }
      case "month":
        return r.response.submittedAt?.slice(0, 7) ?? null;
    }
  };

  const cohortByResponse = new Map<string, string>();
  let unclassified = 0;
  for (const r of rows) {
    const cohort = cohortOf(r);
    if (cohort) cohortByResponse.set(r.response.id, cohort);
    else unclassified++;
  }

  const responseIds = [...cohortByResponse.keys()];
  const scoreRows = responseIds.length
    ? await db.select().from(responseScores).where(inArray(responseScores.responseId, responseIds))
    : [];

  /*
   * Страта прохождения — снэпшоты пола/полосы на момент сдачи (П-1 плана).
   * Стандартная популяция — вся выборка этой методики: у каждой страты вес =
   * её размер в общей выборке. «Рота А тревожнее» на сырых долях слишком
   * часто означает «рота А моложе» — стандартизованная колонка отвечает,
   * что останется от разницы при одинаковой структуре.
   */
  const strataByResponse = new Map<string, string>();
  for (const r of rows) {
    const sx = r.response.respondentSex ?? "?";
    const band = r.response.respondentAgeBand ?? "?";
    strataByResponse.set(r.response.id, `${sx}|${band}`);
  }
  const standardWeights = new Map<string, number>();
  for (const rid of cohortByResponse.keys()) {
    const key = strataByResponse.get(rid) ?? "?|?";
    standardWeights.set(key, (standardWeights.get(key) ?? 0) + 1);
  }

  const result: ComparisonResult = {
    surveyId,
    title: survey.title,
    by,
    unclassified,
    scales: survey.scales
      .filter((s) => s.kind === "clinical")
      .map((scale) => {
        const own = scoreRows.filter((s) => s.scaleId === scale.id);
        const grouped = new Map<string, typeof own>();
        for (const s of own) {
          const cohort = cohortByResponse.get(s.responseId)!;
          const list = grouped.get(cohort) ?? [];
          list.push(s);
          grouped.set(cohort, list);
        }

        return {
          scaleId: scale.id,
          code: scale.code,
          title: scale.title,
          maxScore: own[0]?.maxScore ?? 0,
          normalization: (own[0]?.normalization ?? scale.normalization) as ScaleNormalization,
          cohorts: [...grouped.entries()]
            // мелкие когорты отбрасываем: среднее по двум наблюдениям вводит в заблуждение
            .filter(([, list]) => list.length >= MIN_COHORT)
            .map(([cohort, list]) => {
              const values = list.map((x) => x.value);
              const bandCounts = new Map<string, { severity: Severity; count: number }>();
              for (const x of list) {
                if (!x.bandLabel) continue;
                const cur = bandCounts.get(x.bandLabel);
                bandCounts.set(x.bandLabel, {
                  severity: (x.severity ?? "none") as Severity,
                  count: (cur?.count ?? 0) + 1,
                });
              }
              // доля «высокого риска» (moderate|severe) — сырая и стандартизованная
              const isRisk = (x: (typeof list)[number]) =>
                x.severity === "severe" || x.severity === "moderate";
              const rawShare = list.length ? list.filter(isRisk).length / list.length : 0;

              const byStratum = new Map<string, { n: number; risk: number }>();
              for (const x of list) {
                const key = strataByResponse.get(x.responseId) ?? "?|?";
                const cur = byStratum.get(key) ?? { n: 0, risk: 0 };
                cur.n += 1;
                if (isRisk(x)) cur.risk += 1;
                byStratum.set(key, cur);
              }
              const stdShare = directStandardize(
                [...byStratum.entries()].map(([key, v]) => ({
                  rate: v.risk / v.n,
                  standardWeight: standardWeights.get(key) ?? 0,
                })),
              );

              return {
                cohort,
                rawRiskShare: round(rawShare, 3),
                stdRiskShare: stdShare,
                n: list.length,
                mean: round(average(values)),
                median: round(median(values)),
                sd: round(Math.sqrt(variance(values))),
                min: Math.min(...values),
                max: Math.max(...values),
                bands: [...bandCounts.entries()].map(([label, v]) => ({
                  label,
                  severity: v.severity,
                  count: v.count,
                  percent: percent(v.count, list.length),
                })),
              };
            })
            .sort((a, b) => b.n - a.n),
        };
      }),
  };

  await audit(c, {
    action: "analytics.compare",
    resourceType: "survey",
    resourceId: surveyId,
    details: { by, cohorts: result.scales[0]?.cohorts.length ?? 0 },
  });
  return c.json(result);
});

/**
 * Корреляции между субшкалами внутри методики.
 *
 * Считается только по прохождениям, где есть обе шкалы: попарное удаление,
 * а не подстановка средних — иначе коэффициент завышается искусственно.
 */
comparisonRoutes.get("/surveys/:id/correlations", async (c) => {
  const surveyId = c.req.param("id");
  await assertSurveyAccess(c.get("user"), surveyId);

  const survey = await getSurvey(surveyId, null, "ru");
  if (!survey) notFound("Методика не найдена");

  const responseRows = await db
    .select()
    .from(responses)
    .where(and(eq(responses.surveyId, surveyId), eq(responses.status, "completed")));
  const scoreRows = responseRows.length
    ? await db
        .select()
        .from(responseScores)
        .where(inArray(responseScores.responseId, responseRows.map((r) => r.id)))
    : [];

  const byResponse = new Map<string, Map<string, number>>();
  for (const s of scoreRows) {
    const m = byResponse.get(s.responseId) ?? new Map<string, number>();
    m.set(s.scaleId, s.value);
    byResponse.set(s.responseId, m);
  }

  const clinical = survey.scales.filter((s) => s.kind === "clinical");
  const pairs: CorrelationMatrix["pairs"] = [];
  for (let i = 0; i < clinical.length; i++) {
    for (let j = i + 1; j < clinical.length; j++) {
      const a = clinical[i]!;
      const b = clinical[j]!;
      const xs: number[] = [];
      const ys: number[] = [];
      for (const m of byResponse.values()) {
        const x = m.get(a.id);
        const y = m.get(b.id);
        if (x === undefined || y === undefined) continue;
        xs.push(x);
        ys.push(y);
      }
      pairs.push({
        a: a.code,
        b: b.code,
        n: xs.length,
        r: xs.length >= MIN_CORRELATION_SAMPLE ? round(pearson(xs, ys), 3) : Number.NaN,
      });
    }
  }

  await audit(c, {
    action: "analytics.correlations",
    resourceType: "survey",
    resourceId: surveyId,
    details: { scales: clinical.length, pairs: pairs.length },
  });

  const matrix: CorrelationMatrix = {
    surveyId,
    title: survey.title,
    codes: clinical.map((s) => s.code),
    titles: Object.fromEntries(clinical.map((s) => [s.code, s.title])),
    pairs: pairs.map((p) => ({ ...p, r: Number.isNaN(p.r) ? 0 : p.r })),
    minSample: MIN_CORRELATION_SAMPLE,
  };
  return c.json(matrix);
});
