import { Hono } from "hono";
import { desc, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { CohortPreview, CohortSpec } from "@quizzy/shared";
import { db } from "../db";
import { cohorts, surveys, users } from "../db/schema";
import { audit } from "../lib/audit";
import { fullNameOf } from "../lib/auth";
import { badRequest, notFound, parseBody } from "../lib/http";
import { SMALL_CELL_FLOOR, canBreakDown, suppress } from "../lib/privacy";
import { surveyScopeFilter } from "../lib/scope";
import { requireAuth, requireStaff, type AppEnv } from "../middleware/auth";

export const cohortRoutes = new Hono<AppEnv>();
cohortRoutes.use("*", requireAuth, requireStaff);

/**
 * Конструктор когорт: визуальный запрос без SQL.
 *
 * «Мужчины 20–30 из рот 1–3, прошедшие МЛО за последний квартал, с ЛАП ниже
 * четырёх, у которых есть повторный замер» — вопрос, который задают постоянно,
 * а отвечают на него выгрузкой в SPSS и обратно.
 *
 * Два обязательства, из-за которых этот маршрут написан именно так:
 *
 *  1. Когорта не выходит за зону ответственности. Правило отбора не даёт
 *     доступа: оно только сужает то, что человек и так вправе видеть.
 *  2. Малые ячейки подавляются, как и в отчётах. То, что выборку собрали
 *     конструктором, а не отчётом, не меняет, кого в ней узнают.
 */

const scaleCond = z.object({
  code: z.string().min(1).max(40),
  op: z.enum([">=", "<=", ">", "<"]),
  value: z.number(),
});

const specSchema = z.object({
  sex: z.enum(["male", "female"]).nullable().optional(),
  ageMin: z.number().int().min(0).max(120).nullable().optional(),
  ageMax: z.number().int().min(0).max(120).nullable().optional(),
  units: z.array(z.string().max(120)).max(50).optional(),
  surveyId: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  to: z.string().nullable().optional(),
  scales: z.array(scaleCond).max(10).optional(),
  repeatedOnly: z.boolean().optional(),
  riskOnly: z.boolean().optional(),
});

/**
 * Условие отбора одним SQL.
 *
 * Собирается фрагментами, а не строкой: значения уходят параметрами, и
 * подстановка чужого текста в запрос невозможна по устройству. Название
 * подразделения приходит от человека и вполне может содержать кавычку.
 */
async function cohortWhere(
  user: Parameters<typeof surveyScopeFilter>[0],
  spec: CohortSpec,
): Promise<SQL> {
  const scope = await surveyScopeFilter(user);
  const scoped = await db.select({ id: surveys.id }).from(surveys).where(scope);
  const allowed = scoped.map((s) => s.id);
  if (!allowed.length) return sql`false`;

  if (spec.surveyId && !allowed.includes(spec.surveyId)) {
    /*
     * Методика вне зоны — не «пустая когорта», а отказ. Пустой ответ здесь
     * читался бы как «таких нет», хотя правильный ответ «вам не видно».
     */
    badRequest("err.surveyUnavailable");
  }

  const surveyIds = spec.surveyId ? [spec.surveyId] : allowed;
  const parts: SQL[] = [
    sql`u.role = 'user'`,
    sql`exists (
      select 1 from responses r
      where r.user_id = u.id
        and r.status = 'completed'
        and r.survey_id in ${surveyIds}
        ${spec.from ? sql`and r.submitted_at >= ${spec.from}` : sql``}
        ${spec.to ? sql`and r.submitted_at <= ${spec.to}` : sql``}
    )`,
  ];

  if (spec.sex) parts.push(sql`u.sex = ${spec.sex}`);

  /*
   * Возраст считается по снимку на момент сдачи, а не по нынешней дате
   * рождения: выборка «20–30 лет» должна означать возраст на обследовании.
   * Дата рождения зашифрована, поэтому фильтровать по ней в SQL нельзя — для
   * этого и существует снимок возрастной полосы в прохождении.
   */
  if (spec.ageMin != null || spec.ageMax != null) {
    const bands: string[] = [];
    for (const band of ["<25", "25-34", "35-44", "45+"]) {
      const [lo, hi] =
        band === "<25" ? [0, 24] : band === "25-34" ? [25, 34] : band === "35-44" ? [35, 44] : [45, 120];
      if ((spec.ageMax ?? 120) < lo) continue;
      if ((spec.ageMin ?? 0) > hi) continue;
      bands.push(band);
    }
    if (!bands.length) return sql`false`;
    parts.push(sql`exists (
      select 1 from responses r2
      where r2.user_id = u.id and r2.respondent_age_band in ${bands}
    )`);
  }

  if (spec.units?.length) parts.push(sql`u.unit in ${spec.units}`);

  if (spec.repeatedOnly) {
    parts.push(sql`(
      select count(*) from responses r3
      where r3.user_id = u.id and r3.status = 'completed'
        and r3.survey_id in ${surveyIds}
    ) >= 2`);
  }

  if (spec.riskOnly) {
    parts.push(sql`exists (select 1 from risk_alerts ra where ra.user_id = u.id)`);
  }

  for (const cond of spec.scales ?? []) {
    /*
     * Оператор подставляется из закрытого перечня, а не из строки запроса:
     * drizzle не параметризует оператор, и единственная защита здесь — то, что
     * значение вообще не приходит снаружи в свободном виде.
     */
    const op =
      cond.op === ">=" ? sql`>=` : cond.op === "<=" ? sql`<=` : cond.op === ">" ? sql`>` : sql`<`;
    parts.push(sql`exists (
      select 1 from response_scores rs
      join responses r4 on r4.id = rs.response_id
      join scales sc on sc.id = rs.scale_id
      where r4.user_id = u.id
        and r4.status = 'completed'
        and r4.survey_id in ${surveyIds}
        and sc.code = ${cond.code}
        and rs.value ${op} ${cond.value}
    )`);
  }

  return sql.join(parts, sql` and `);
}

cohortRoutes.post("/preview", async (c) => {
  const user = c.get("user");
  const spec = await parseBody(c.req.raw, specSchema);
  const where = await cohortWhere(user, spec);

  const [{ n = 0 } = { n: 0 }] = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from users u where ${where}`,
  );
  const size = Number(n);

  /*
   * Разбивки показываются только у достаточно большой когорты. У когорты из
   * трёх человек «мужчин: 1» указывает на конкретного — ровно так же, как в
   * отчёте по роте.
   */
  const allowed = canBreakDown(size);

  const group = async (column: SQL): Promise<{ key: string; count: number | null }[]> => {
    if (!allowed) return [];
    const rows = await db.execute<{ key: string | null; n: number }>(
      sql`select ${column} as key, count(*)::int as n from users u where ${where} group by 1 order by 2 desc limit 20`,
    );
    return [...rows].map((r) => ({ key: r.key ?? "—", count: suppress(Number(r.n)) }));
  };

  const bySeverity = allowed
    ? [
        ...(await db.execute<{ key: string | null; n: number }>(sql`
          select rs.severity as key, count(distinct u.id)::int as n
          from users u
          join responses r on r.user_id = u.id and r.status = 'completed'
          join response_scores rs on rs.response_id = r.id
          where ${where} and rs.severity is not null
          group by 1 order by 2 desc
        `)),
      ].map((r) => ({ key: r.key ?? "—", count: suppress(Number(r.n)) }))
    : [];

  await audit(c, { action: "cohort.preview", details: { size, spec } });

  return c.json({
    // размер тоже подавляется: «нашлось 2» — это уже сведение о двух людях
    size: suppress(size),
    breakdownAllowed: allowed,
    smallCellFloor: SMALL_CELL_FLOOR,
    bySex: await group(sql`u.sex`),
    byUnit: await group(sql`u.unit`),
    bySeverity,
  } satisfies CohortPreview);
});

/**
 * Список когорты поимённо.
 *
 * Отдельный маршрут, а не поле в предпросмотре: посмотреть распределение и
 * увидеть имена — разные действия с разными последствиями, и в журнале они
 * должны различаться.
 */
cohortRoutes.post("/members", async (c) => {
  const user = c.get("user");
  const spec = await parseBody(c.req.raw, specSchema);
  const where = await cohortWhere(user, spec);

  const rows = await db.execute<{ id: string }>(
    sql`select u.id from users u where ${where} limit 500`,
  );
  const ids = [...rows].map((r) => r.id);
  if (!ids.length) return c.json({ items: [] });

  const people = await db.select().from(users).where(sql`${users.id} in ${ids}`);

  await audit(c, { action: "cohort.members", details: { size: ids.length, spec } });

  return c.json({
    items: people.map((p) => ({
      userId: p.id,
      fullName: fullNameOf(p),
      unit: p.unit,
      sex: p.sex,
    })),
  });
});

/* ── сохранённые когорты ── */

const saveSchema = z.object({
  title: z.string().min(1).max(200),
  note: z.string().max(1000).nullable().optional(),
  spec: specSchema,
});

cohortRoutes.get("/", async (c) => {
  const user = c.get("user");
  const rows = await db
    .select()
    .from(cohorts)
    .where(eq(cohorts.createdBy, user.id))
    .orderBy(desc(cohorts.createdAt));

  return c.json({
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      note: r.note,
      spec: r.spec as CohortSpec,
      createdAt: r.createdAt,
    })),
  });
});

cohortRoutes.post("/", async (c) => {
  const user = c.get("user");
  const input = await parseBody(c.req.raw, saveSchema);

  const id = crypto.randomUUID();
  await db.insert(cohorts).values({
    id,
    title: input.title,
    note: input.note ?? null,
    spec: input.spec,
    createdBy: user.id,
  });

  await audit(c, { action: "cohort.save", resourceType: "cohort", resourceId: id });
  return c.json({ id }, 201);
});

cohortRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");

  const [row] = await db
    .delete(cohorts)
    .where(sql`${cohorts.id} = ${id} and ${cohorts.createdBy} = ${user.id}`)
    .returning();
  if (!row) notFound("err.cohortNotFound");

  await audit(c, { action: "cohort.delete", resourceType: "cohort", resourceId: id });
  return c.json({ ok: true });
});
