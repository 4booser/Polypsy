import { Hono } from "hono";
import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";
import { t, type Severity } from "@quizzy/shared";
import { db } from "../db";
import { responses, responseScores, scales, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { badRequest, parseQuery } from "../lib/http";
import { surveyScopeFilter } from "../lib/scope";
import { SMALL_CELL_FLOOR, suppress } from "../lib/privacy";
import { requireAuth, requirePermission, requireStaff, type AppEnv } from "../middleware/auth";
import { z } from "zod";
import { queryDate } from "@quizzy/shared";

/**
 * Состояние подразделения за период.
 *
 * Отвечает на вопрос командира и начальника отделения: «что с людьми». Не
 * даёт при этом посмотреть на конкретного человека — для этого есть карта
 * пациента, и она под другим доступом.
 *
 * Малые ячейки подавляются. Это не формальность: в роте на двенадцать человек
 * строка «выраженная степень: 1» указывает на конкретного, и по ней его
 * узнают сослуживцы. Порог тот же, что в остальной аналитике.
 */
export const unitReportRoutes = new Hono<AppEnv>();

/*
 * Право проверяется рядом со старой проверкой персонала, а не вместо неё.
 *
 * Замена идёт по одному набору маршрутов, от читающих к клиническим: так на
 * каждом шаге видно, что сломалось, потому что сломаться может немногое.
 * Сегодня разницы в поведении нет — встроенная роль есть у каждого
 * администратора, — и это ровно то, чего мы хотим от перехода.
 */
unitReportRoutes.use("*", requireAuth, requireStaff, requirePermission("unitReport.read"));



const query = z.object({
  unit: z.string().min(1).max(120),
  from: queryDate.optional(),
  to: queryDate.optional(),
});

unitReportRoutes.get("/units", async (c) => {
  const rows = await db
    .selectDistinct({ unit: users.unit })
    .from(users)
    .where(and(eq(users.role, "user"), isNotNull(users.unit)));
  return c.json({ items: rows.map((r) => r.unit).filter(Boolean).sort() });
});

unitReportRoutes.get("/", async (c) => {
  const user = c.get("user");
  const q = parseQuery(c, query);

  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id, title: surveys.title }).from(surveys).where(scope);
  if (!scoped.length) badRequest("err.noAccessibleSurveys");
  const surveyIds = scoped.map((s) => s.id);
  const titleOf = new Map(scoped.map((s) => [s.id, t(s.title as never)]));

  // условия для drizzle-запросов
  const period = [
    inArray(responses.surveyId, surveyIds),
    eq(responses.status, "completed"),
    eq(users.unit, q.unit),
    ...(q.from ? [gte(responses.submittedAt, q.from)] : []),
    ...(q.to ? [lte(responses.submittedAt, `${q.to} 23:59:59`)] : []),
  ];

  /*
   * Те же условия для сырого SQL. Собираются отдельно, потому что в сыром
   * запросе таблицы стоят под псевдонимами: drizzle отрендерил бы
   * "responses"."survey_id", а в FROM написано `responses r`.
   */
  const idList = sql`(${sql.join(surveyIds.map((id) => sql`${id}`), sql`, `)})`;
  const rawPeriod = sql`
    r.survey_id in ${idList}
    and r.status = 'completed'
    and u.unit = ${q.unit}
    ${q.from ? sql`and r.submitted_at >= ${q.from}` : sql``}
    ${q.to ? sql`and r.submitted_at <= ${`${q.to} 23:59:59`}` : sql``}
  `;

  const [coverage, bySurvey, severityRows, riskRows] = await Promise.all([
    // охват: сколько людей подразделения вообще обследовано
    db.execute<{ people: number; measured: number; responses: number } & Record<string, unknown>>(sql`
      select
        (select count(*)::int from users where role = 'user' and unit = ${q.unit}) as people,
        count(distinct r.user_id)::int as measured,
        count(*)::int                  as responses
      from responses r join users u on u.id = r.user_id
      where ${rawPeriod}
    `),
    db
      .select({
        surveyId: responses.surveyId,
        n: sql<number>`count(*)::int`,
        people: sql<number>`count(distinct ${responses.userId})::int`,
      })
      .from(responses)
      .innerJoin(users, eq(users.id, responses.userId))
      .where(and(...period))
      .groupBy(responses.surveyId),
    db
      .select({
        code: scales.code,
        title: scales.title,
        severity: responseScores.severity,
        n: sql<number>`count(*)::int`,
      })
      .from(responseScores)
      .innerJoin(responses, eq(responses.id, responseScores.responseId))
      .innerJoin(users, eq(users.id, responses.userId))
      .innerJoin(scales, eq(scales.id, responseScores.scaleId))
      .where(and(...period, isNotNull(responseScores.severity)))
      .groupBy(scales.code, scales.title, responseScores.severity),
    // сколько человек хоть раз попало в тяжёлую полосу
    db.execute<{ n: number } & Record<string, unknown>>(sql`
      select count(distinct r.user_id)::int as n
      from response_scores rs
      join responses r on r.id = rs.response_id
      join users u on u.id = r.user_id
      where ${rawPeriod} and rs.severity = 'severe'
    `),
  ]);

  const cover = [...coverage][0];
  const people = Number(cover?.people ?? 0);
  const measured = Number(cover?.measured ?? 0);

  /*
   * Свод по шкалам: доли, а не абсолютные числа, и только там, где людей
   * достаточно. Ячейка меньше порога отдаётся как null — «не показываем»,
   * а не как ноль: ноль читался бы как «таких нет».
   */
  const byScale = new Map<string, { code: string; title: string; counts: Record<string, number>; total: number }>();
  for (const r of severityRows) {
    const key = r.code;
    const entry = byScale.get(key) ?? { code: r.code, title: t(r.title as never), counts: {}, total: 0 };
    entry.counts[r.severity!] = (entry.counts[r.severity!] ?? 0) + Number(r.n);
    entry.total += Number(r.n);
    byScale.set(key, entry);
  }

  const scalesOut = [...byScale.values()]
    .filter((s) => s.total >= SMALL_CELL_FLOOR)
    .map((s) => ({
      code: s.code,
      title: s.title,
      total: s.total,
      breakdown: (["none", "mild", "moderate", "severe"] as Severity[]).map((sev) => {
        const n = s.counts[sev] ?? 0;
        return {
          severity: sev,
          // подавляем маленькую ячейку, а не всю строку: доля по остальным
          // остаётся полезной, а по одному человеку его не вычислят
          count: suppress(n),
          percent: Math.round((n / s.total) * 100),
        };
      }),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));

  const result = {
    unit: q.unit,
    from: q.from ?? null,
    to: q.to ?? null,
    people,
    measured,
    coverage: people ? Math.round((measured / people) * 100) : 0,
    responses: Number(cover?.responses ?? 0),
    atRisk: suppress(Number([...riskRows][0]?.n ?? 0)),
    smallCellFloor: SMALL_CELL_FLOOR,
    surveys: bySurvey
      .map((r) => ({
        surveyId: r.surveyId,
        title: titleOf.get(r.surveyId) ?? "—",
        responses: Number(r.n),
        people: Number(r.people),
      }))
      .sort((a, b) => b.responses - a.responses),
    scales: scalesOut,
  };

  await audit(c, {
    action: "report.unit",
    details: { unit: q.unit, from: q.from, to: q.to, measured, responses: result.responses },
  });

  return c.json(result);
});
