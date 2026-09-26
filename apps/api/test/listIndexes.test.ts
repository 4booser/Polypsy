import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { desc } from "drizzle-orm";
import { client, db, isNull, sql } from "./fixtures";
import { alertCases } from "../src/db/schema";

/**
 * Индексы под списки (миграция 0097).
 *
 * Внешний разбор: «не хватало индекса risk_alerts.case_id, а индекс открытых
 * случаев не соответствовал запросу». Первое к этому времени уже было
 * исправлено (0028), второе — нет: очередь стала упорядочиваться по тяжести,
 * а индекс остался под прежний порядок, и план сортировал все открытые
 * случаи ради первой страницы.
 *
 * Наличие индекса само по себе ничего не доказывает — 0028 тоже завела
 * индекс, который потом ни разу не использовался. Поэтому здесь спрашивается
 * план: отдаёт ли индекс строки в порядке очереди без сортировки.
 */

async function indexDef(name: string): Promise<string | null> {
  const [row] = await client<{ indexdef: string }[]>`
    select indexdef from pg_indexes where schemaname = 'public' and indexname = ${name}
  `;
  // определение сжимается в одну строку: CASE база печатает с переносами
  return row ? row.indexdef.replace(/\s+/g, " ") : null;
}

type PlanNode = { "Node Type": string; "Index Name"?: string; Plans?: PlanNode[] };
function nodes(plan: PlanNode): PlanNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

/**
 * План запроса при запрещённых обходных путях.
 *
 * В тестовой базе случаев единицы, и честный планировщик выбрал бы
 * последовательное чтение и сортировку — на таком объёме это и правда
 * дешевле. Запрет сканирования и сортировки не заставляет индекс подойти:
 * если он не отдаёт нужный порядок, сортировка всё равно появится в плане,
 * только станет «дорогой». Ровно это и проверяется.
 */
async function planOf(query: { sql: string; params: unknown[] }): Promise<PlanNode[]> {
  return client.begin(async (tx) => {
    await tx.unsafe("set local enable_seqscan = off");
    await tx.unsafe("set local enable_bitmapscan = off");
    await tx.unsafe("set local enable_sort = off");
    const [row] = await tx.unsafe(`explain (format json) ${query.sql}`, query.params as never[]);
    const plan = (row as unknown as { "QUERY PLAN": { Plan: PlanNode }[] })["QUERY PLAN"][0]!.Plan;
    return nodes(plan);
  }) as Promise<PlanNode[]>;
}

/* то же выражение, что severityRank в routes/alertCases.ts — сторож ниже сверяет их текстом */
const severityRank = sql<number>`(case when ${alertCases.severity} = 'severe' then 1 else 0 end)`;

describe("индексы под списки", () => {
  test("у сигналов есть индекс по случаю, и счётчик сигналов идёт по нему", async () => {
    expect(await indexDef("alerts_case_idx")).toContain("(case_id)");

    const found = await planOf({ sql: "select count(*) from risk_alerts where case_id = $1", params: ["нет-такого"] });
    expect(found.some((n) => n["Index Name"] === "alerts_case_idx")).toBe(true);
  });

  test("индекс очереди повторяет её порядок: тяжесть, время, идентификатор — только открытые", async () => {
    const def = await indexDef("alert_cases_queue_idx");
    expect(def).not.toBeNull();
    expect(def!).toMatch(/\( ?CASE WHEN \(severity = 'severe'::text\) THEN 1 ELSE 0 END\) DESC, last_alert_at DESC, id DESC\)/);
    expect(def!).toContain("WHERE (acknowledged_at IS NULL)");
    // прежний, под старый порядок, снят: два индекса на одно и то же — лишняя запись на каждую тревогу
    expect(await indexDef("alert_cases_open_idx")).toBeNull();
  });

  test("первая страница очереди читается индексом без сортировки", async () => {
    const query = db
      .select({ id: alertCases.id })
      .from(alertCases)
      .where(isNull(alertCases.acknowledgedAt))
      .orderBy(desc(severityRank), desc(alertCases.lastAlertAt), desc(alertCases.id))
      .limit(31)
      .toSQL();
    const found = await planOf(query);
    expect(found.some((n) => n["Index Name"] === "alert_cases_queue_idx")).toBe(true);
    expect(found.map((n) => n["Node Type"])).not.toContain("Sort");
  });

  test("следующая страница — тоже: условие курсора ложится на тот же индекс", async () => {
    const query = db
      .select({ id: alertCases.id })
      .from(alertCases)
      .where(
        sql`${isNull(alertCases.acknowledgedAt)} and (${severityRank}, ${alertCases.lastAlertAt}, ${alertCases.id})
            < (${1}, ${new Date().toISOString()}::timestamptz, ${"zzz"})`,
      )
      .orderBy(desc(severityRank), desc(alertCases.lastAlertAt), desc(alertCases.id))
      .limit(31)
      .toSQL();
    const found = await planOf(query);
    expect(found.some((n) => n["Index Name"] === "alert_cases_queue_idx")).toBe(true);
    expect(found.map((n) => n["Node Type"])).not.toContain("Sort");
  });

  /*
   * Индекс подходит запросу, пока выражение тяжести в маршруте то же самое.
   * Поменяют его там (другая шкала рангов, ещё одна ступень) — индекс молча
   * превратится в фильтр, как уже случилось однажды. Маршрут принадлежит
   * другому участку, поэтому сверка — по тексту исходника: упала — значит,
   * вместе с порядком очереди пора менять и индекс.
   */
  test("сторож: порядок очереди в маршруте тот, под который построен индекс", () => {
    const source = readFileSync(new URL("../src/routes/alertCases.ts", import.meta.url), "utf8");
    expect(source).toContain(
      "const severityRank = sql<number>`(case when ${alertCases.severity} = 'severe' then 1 else 0 end)`;",
    );
    expect(source).toContain(".orderBy(desc(severityRank), desc(alertCases.lastAlertAt), desc(alertCases.id))");
    expect(source).toContain("isNull(alertCases.acknowledgedAt)");
  });
});
