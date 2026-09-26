/**
 * Медленные SQL из pg_stat_statements: топ по суммарному времени, по числу
 * вызовов, по среднему, и план запроса по кнопке.
 *
 * Решение заказчика 2026-09-26. Раздел «База» отвечает «что висит сейчас»;
 * этот — «что стоит дороже всего вообще». Сотня запросов по 20 мс в минуту
 * съедает больше, чем один отчёт на 3 секунды раз в день, и увидеть это
 * можно только по накопленной статистике.
 *
 * Расширение может быть не включено — это состояние установки, а не сбой:
 *   — notInstalled: CREATE EXTENSION не делали (миграция 0093 делает его,
 *     если роль миграций — суперпользователь, иначе пропускает);
 *   — notLoaded: расширение есть, но сервер базы запущен без
 *     shared_preload_libraries — сбор не идёт, представление отвечает
 *     ошибкой 55000;
 *   — denied: у роли приложения отняли право на представление (42501).
 * Экран на каждое говорит, что сделать. Запросы чужих ролей без
 * pg_read_all_stats видны без текста («<insufficient privilege>») — они
 * не показываются, но считаются (hidden).
 *
 * Текст запроса pg_stat_statements уже нормализован (константы → $1), но
 * служебные команды (SET, CREATE ROLE … PASSWORD '…') он хранит как есть —
 * поэтому на экран текст идёт ещё и через normalizeSql (литералы → «?»).
 *
 * План — EXPLAIN без ANALYZE: чужой запрос не выполняется. Для текста с
 * $1 — EXPLAIN (GENERIC_PLAN), PostgreSQL 16+ (в docker-compose.yml — 16).
 * Поверх — пояса: объясняется только один SELECT/WITH/INSERT/UPDATE/DELETE
 * без «;» в середине, в отдельной транзакции READ ONLY с тайм-аутом три
 * секунды. Текст берётся из самого pg_stat_statements по queryid, а не из
 * запроса смотрящего: подсунуть свой текст на EXPLAIN нельзя.
 */
import { sql } from "drizzle-orm";
import type { OpsPlanState, OpsStatement, OpsStatementPlan, OpsStatementSort, OpsStatements, OpsStatementsState } from "@quizzy/shared";
import { client } from "../db";
import { log } from "./log";
import { normalizeSql, liveProbe, type Probe } from "./opsDb";
import { scrubText } from "./opsBuffer";

const HIDDEN_TEXT = "<insufficient privilege>";

/** Код отказа Postgres → состояние раздела */
export function stateOfError(error: unknown): OpsStatementsState {
  const code = (error as { code?: unknown }).code;
  if (code === "55000") return "notLoaded";
  if (code === "42501") return "denied";
  if (code === "42P01" || code === "42883") return "notInstalled";
  return "failed";
}

const ORDER: Record<OpsStatementSort, string> = {
  total: "total_exec_time",
  calls: "calls",
  mean: "mean_exec_time",
};

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Топ запросов своей базы. Каждый вопрос — через зонд (Probe): в бою это
 * точка сохранения в транзакции запроса, в тесте — подстановка, которая
 * отвечает «не загружено» или «нет прав».
 */
export async function collectStatements(sort: OpsStatementSort, probe: Probe = liveProbe, limit = 25): Promise<OpsStatements> {
  const empty = (state: OpsStatementsState): OpsStatements => ({ state, sort, hidden: 0, statsSince: null, items: [] });

  try {
    const ext = await probe(sql`select extversion from pg_extension where extname = 'pg_stat_statements'`);
    if (!ext.length) return empty("notInstalled");
  } catch (error) {
    return empty(stateOfError(error));
  }

  let rows: Record<string, unknown>[];
  let totals: Record<string, unknown> | undefined;
  try {
    [totals] = await probe(sql`
      select count(*) filter (where query = ${HIDDEN_TEXT})::int as hidden,
             sum(total_exec_time) filter (where query <> ${HIDDEN_TEXT}) as total
      from pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())
    `);
    rows = await probe(sql`
      select queryid::text as id, calls, total_exec_time, mean_exec_time, rows, left(query, 4000) as query
      from pg_stat_statements
      where dbid = (select oid from pg_database where datname = current_database())
        and query <> ${HIDDEN_TEXT}
        and queryid is not null
      order by ${sql.raw(ORDER[sort])} desc nulls last
      limit ${limit}
    `);
  } catch (error) {
    const state = stateOfError(error);
    if (state === "failed") log.warn("ops.statements_failed", { error: String(error) });
    return empty(state);
  }

  /* момент сброса статистики — PostgreSQL 14+; нет представления — просто не знаем */
  let statsSince: string | null = null;
  try {
    const [info] = await probe(sql`select stats_reset from pg_stat_statements_info`);
    statsSince = info?.stats_reset ? new Date(info.stats_reset as string).toISOString() : null;
  } catch {
    statsSince = null;
  }

  const total = num(totals?.total);
  const items: OpsStatement[] = rows.map((r) => ({
    id: String(r.id),
    calls: num(r.calls),
    totalMs: r1(num(r.total_exec_time)),
    meanMs: r1(num(r.mean_exec_time)),
    rows: num(r.rows),
    share: total > 0 ? num(r.total_exec_time) / total : null,
    query: normalizeSql(String(r.query ?? ""), 500),
  }));
  return { state: "ok", sort, hidden: num(totals?.hidden), statsSince, items };
}

/* ─────────── план ─────────── */

/**
 * Текст, который можно объяснить, или null. Один оператор данных — без
 * «;» внутри (простой протокол выполнил бы второй оператор целиком), без
 * служебных команд (EXPLAIN их и не умеет), не длиннее 20 000 знаков.
 * Строка, начатая с комментария, тоже отказ: проверить первое слово под
 * комментарием можно, но проще и надёжнее не объяснять такое вовсе.
 */
export function explainable(text: string): string | null {
  let t = text.trim();
  if (t.endsWith(";")) t = t.slice(0, -1).trimEnd();
  if (!t || t.length > 20_000 || t.includes(";")) return null;
  if (!/^(select|with|insert|update|delete|values|table)\b/i.test(t)) return null;
  return t;
}

/** Строка плана на экран: отступы сохранены, литералы — «?», почта и телефоны — маской */
export function cleanPlanLine(line: string): string {
  return scrubText(line.replace(/'(?:[^']|'')*'/g, "'?'"), 1000);
}

/** Выполнитель EXPLAIN: в бою — отдельная транзакция READ ONLY; в тесте — подстановка */
export type Explainer = (text: string, generic: boolean) => Promise<string[]>;

/**
 * Отдельная транзакция, а не точка сохранения в транзакции запроса:
 * READ ONLY ставится только первой командой транзакции, а тайм-аут —
 * своим, короче общего. app.role = system — план строится так, как его
 * строит фоновая часть: политики строк в нём видны фильтром, а не
 * «ничего не видно». Простой протокол (.simple()) — единственный, в
 * котором $1 в тексте означает «параметр без значения», а не требование
 * передать значение.
 */
export const liveExplainer: Explainer = async (text, generic) => {
  const rows = await client.begin(async (tx) => {
    await tx.unsafe("set transaction read only");
    await tx.unsafe("set local statement_timeout = '3s'");
    await tx.unsafe("select set_config('app.role', 'system', true)");
    return tx.unsafe(`explain (${generic ? "generic_plan, " : ""}costs true, format text) ${text}`).simple();
  });
  return (rows as unknown as Record<string, unknown>[]).map((r) => String(r["QUERY PLAN"] ?? ""));
};

export async function explainStatement(
  id: string,
  probe: Probe = liveProbe,
  explainer: Explainer = liveExplainer,
): Promise<OpsStatementPlan> {
  const none = (state: OpsPlanState, query: string | null = null): OpsStatementPlan => ({ state, generic: false, plan: null, query });
  if (!/^-?\d{1,20}$/.test(id)) return none("notFound");

  let text: string;
  let version: number;
  try {
    const [row] = await probe(sql`
      select query from pg_stat_statements
      where queryid = ${id}::bigint
        and dbid = (select oid from pg_database where datname = current_database())
        and query <> ${HIDDEN_TEXT}
      limit 1
    `);
    if (!row) return none("notFound");
    text = String(row.query ?? "");
    const [v] = await probe(sql`select current_setting('server_version_num')::int as v`);
    version = Number(v?.v ?? 0);
  } catch (error) {
    return none(stateOfError(error) === "denied" ? "denied" : "unavailable");
  }

  const shown = normalizeSql(text, 2000);
  const target = explainable(text);
  if (!target) return none("refused", shown);
  const generic = /\$\d/.test(target);
  if (generic && version < 160000) return none("needsPg16", shown);

  try {
    const plan = await explainer(target, generic);
    return { state: "ok", generic, plan: plan.map(cleanPlanLine), query: shown };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "42501") return none("denied", shown);
    log.warn("ops.explain_failed", { error: String(error) });
    return none("failed", shown);
  }
}
