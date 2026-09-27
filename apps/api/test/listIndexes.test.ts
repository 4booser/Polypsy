import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { client, db, isNull } from "./fixtures";
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
 * план: берёт ли его запрос, ради которого он заведён.
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

describe("индексы под списки", () => {
  test("у сигналов есть индекс по случаю, и счётчик сигналов идёт по нему", async () => {
    expect(await indexDef("alerts_case_idx")).toContain("(case_id)");

    const found = await planOf({ sql: "select count(*) from risk_alerts where case_id = $1", params: ["нет-такого"] });
    expect(found.some((n) => n["Index Name"] === "alerts_case_idx")).toBe(true);
  });

  /*
   * Поправка при сведении волны 12: индекс под порядок очереди снят (очередь
   * сложена по человеку и порядок наводит сама), вместо него — частичный по
   * открытым случаям человека. Он нужен двум запросам: поиску открытого
   * случая при сдаче и выборке открытой очереди без чтения закрытых.
   */
  test("индекс открытых случаев — по человеку и только открытые; прежние сняты", async () => {
    const def = await indexDef("alert_cases_open_user_idx");
    expect(def).not.toBeNull();
    expect(def!).toContain("(user_id)");
    expect(def!).toContain("WHERE (acknowledged_at IS NULL)");
    expect(await indexDef("alert_cases_open_idx")).toBeNull();
    expect(await indexDef("alert_cases_queue_idx")).toBeNull();
  });

  /*
   * Какой из двух индексов по человеку возьмёт планировщик — частичный по
   * открытым или полный alert_cases_user_idx, — решает статистика таблицы:
   * на локальной базе брал первый, в CI второй. Оба годятся, поэтому
   * проверяется суть — поиск идёт индексом, а не проходом по всем случаям.
   */
  test("открытый случай человека ищется индексом, а не проходом по таблице", async () => {
    const query = db
      .select({ id: alertCases.id })
      .from(alertCases)
      .where(and(eq(alertCases.userId, "нет-такого"), isNull(alertCases.acknowledgedAt)))
      .toSQL();
    const found = await planOf(query);
    const used = found.map((n) => n["Index Name"]).filter(Boolean);
    expect(used.some((name) => name === "alert_cases_open_user_idx" || name === "alert_cases_user_idx")).toBe(true);
    expect(found.map((n) => n["Node Type"])).not.toContain("Seq Scan");
  });

  test("открытая очередь читает только открытые — индексом, без полного прохода", async () => {
    const query = db.select({ id: alertCases.id }).from(alertCases).where(isNull(alertCases.acknowledgedAt)).toSQL();
    const found = await planOf(query);
    expect(found.some((n) => n["Index Name"] === "alert_cases_open_user_idx")).toBe(true);
    expect(found.map((n) => n["Node Type"])).not.toContain("Seq Scan");
  });

  /*
   * Индекс подходит, пока горячий путь ищет открытый случай именно так.
   * Путь принадлежит другому участку, поэтому сверка — по тексту исходника:
   * упала — значит, вместе с поиском случая пора менять и индекс.
   */
  test("сторож: поиск открытого случая в attachCaseRow — по человеку и открытости", () => {
    const source = readFileSync(new URL("../src/lib/alertCases.ts", import.meta.url), "utf8");
    expect(source).toContain("eq(alertCases.userId, params.userId)");
    expect(source).toContain("isNull(alertCases.acknowledgedAt)");
  });
});
