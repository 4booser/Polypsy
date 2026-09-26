/**
 * Что техпанель спрашивает у базы: размеры, подключения, долгие запросы,
 * ожидания блокировок, миграции.
 *
 * Главное свойство — ни один вопрос не роняет ответ. Роль приложения в бою
 * — quizzy_app без прав владельца (docker-compose.yml), и в зависимости от
 * установки ей может не хватить прав на pg_stat_activity или на схему
 * drizzle. Экран в таком случае показывает «нет прав — вот почему», а не
 * пятисотку на весь раздел.
 *
 * Отсюда два приёма:
 *
 *   — каждый вопрос идёт в своей точке сохранения (вложенная транзакция
 *     drizzle = SAVEPOINT). Запрос внутри requireAuth уже живёт в
 *     транзакции, и одна ошибка Postgres переводит её в aborted: все
 *     следующие вопросы и запись в журнал падали бы «current transaction is
 *     aborted». Откат к точке сохранения оставляет транзакцию живой;
 *
 *   — вопрос задаётся через `Probe`, а не прямо через db: тест подставляет
 *     зонд, который отвечает «permission denied», и проверяет, что раздел
 *     стал null с пояснением, а соседние остались на месте. Отнимать права
 *     у настоящей роли ради теста нельзя — роль общая на кластер, и
 *     параллельные прогоны делили бы её.
 */
import { sql, type SQL } from "drizzle-orm";
import type {
  OpsConnState,
  OpsConnections,
  OpsDb,
  OpsDbNote,
  OpsLockWait,
  OpsLongQuery,
  OpsMigration,
  OpsTableStat,
} from "@quizzy/shared";
import journal from "../../drizzle/meta/_journal.json" with { type: "json" };
import { db } from "../db";
import { log } from "./log";
import { scrubText } from "./opsBuffer";

/** Один вопрос к базе. Строки — как их отдаёт драйвер: bigint строкой, массивы массивами */
export type Probe = (query: SQL) => Promise<Record<string, unknown>[]>;

/**
 * Живой зонд: вопрос в своей точке сохранения. Вне транзакции (тест,
 * консольный вызов) `db.transaction` открывает обычную — тоже годится.
 */
export const liveProbe: Probe = (query) =>
  db.transaction(async (sp) => (await sp.execute(query)) as unknown as Record<string, unknown>[]);

type Outcome<T> = { ok: true; value: T } | { ok: false; denied: boolean };

/**
 * Вопрос, который не роняет ответ. «Нет прав» (42501) — ожидаемое состояние
 * установки, о нём говорит пояснение на экране; всё прочее — неожиданность,
 * и она уходит в лог предупреждением: раздел пуст, но причина не потеряна.
 */
export async function attempt<T>(what: string, fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    const denied = (error as { code?: string }).code === "42501";
    if (!denied) log.warn("ops.db_probe_failed", { probe: what, error: String(error) });
    return { ok: false, denied };
  }
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null);

/**
 * Текст запроса в показываемом виде: литералы в кавычках — «?», пробелы
 * схлопнуты, не длиннее 200 знаков.
 *
 * Приложение ходит в базу параметрами ($1, $2), так что значений в тексте
 * обычно нет. Но «обычно» — не гарантия: консольный psql администратора,
 * миграция, ручной UPDATE видны здесь тоже, и строка
 * `where email = 'ivanenko@…'` не должна доехать до экрана разработчика.
 */
export function normalizeSql(query: string, max = 200): string {
  const flat = scrubText(
    query
      .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "?")
      .replace(/(?<![\w])[EeBbXxNnUu]?&?'(?:[^']|'')*'/g, "?")
      .replace(/\s+/g, " ")
      .trim(),
    10_000,
  );
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const STATE: Record<string, OpsConnState> = {
  active: "active",
  idle: "idle",
  "idle in transaction": "idle_in_transaction",
  "idle in transaction (aborted)": "idle_in_transaction_aborted",
  "fastpath function call": "fastpath",
  disabled: "disabled",
  hidden: "hidden",
};

/**
 * Подключения к своей базе по состояниям.
 *
 * Без pg_read_all_stats роль видит чужие сессии, но не их содержимое:
 * query = '<insufficient privilege>', state = NULL. Такие считаются
 * отдельной строкой «hidden» — число подключений от этого не врёт, а экран
 * объясняет, почему у части нет состояния. Служебные процессы без
 * состояния (autovacuum и прочие) не считаются: к нагрузке приложения они
 * отношения не имеют.
 */
async function readConnections(probe: Probe): Promise<{ value: OpsConnections; hidden: boolean }> {
  const rows = await probe(sql`
    select case when query = '<insufficient privilege>' then 'hidden' else state end as state,
           count(*)::int as n,
           current_setting('max_connections')::int as max
    from pg_stat_activity
    where datname = current_database()
    group by 1
  `);
  const byState: OpsConnections["byState"] = [];
  let max: number | null = null;
  for (const r of rows) {
    max = num(r.max);
    const code = r.state ? STATE[String(r.state)] : undefined;
    if (!code) continue;
    byState.push({ state: code, count: Number(r.n) });
  }
  byState.sort((a, b) => b.count - a.count);
  return {
    value: { total: byState.reduce((s, x) => s + x.count, 0), byState, max },
    hidden: byState.some((x) => x.state === "hidden"),
  };
}

async function readLongQueries(probe: Probe): Promise<OpsLongQuery[]> {
  const rows = await probe(sql`
    select pid,
           extract(epoch from (now() - query_start))::float8 as seconds,
           state,
           case when wait_event is null then null else wait_event_type || ':' || wait_event end as wait,
           left(query, 4000) as query
    from pg_stat_activity
    where datname = current_database()
      and pid <> pg_backend_pid()
      and state is not null and state <> 'idle'
      and query_start < now() - interval '5 seconds'
    order by query_start
    limit 20
  `);
  return rows.map((r) => ({
    pid: Number(r.pid),
    seconds: Math.round(Number(r.seconds)),
    state: STATE[String(r.state)] ?? null,
    waitEvent: r.wait ? String(r.wait) : null,
    query: normalizeSql(String(r.query ?? "")),
  }));
}

async function readLocks(probe: Probe): Promise<OpsLockWait[]> {
  const rows = await probe(sql`
    select a.pid,
           extract(epoch from (now() - coalesce(a.query_start, now())))::float8 as seconds,
           l.locktype as lock_type,
           l.mode as lock_mode,
           case when l.relation is null then null else l.relation::regclass::text end as relation,
           pg_blocking_pids(a.pid) as blocked_by,
           left(a.query, 4000) as query
    from pg_locks l
    join pg_stat_activity a on a.pid = l.pid
    where not l.granted and a.datname = current_database()
    order by a.query_start
    limit 20
  `);
  return rows.map((r) => ({
    pid: Number(r.pid),
    seconds: Math.round(Number(r.seconds)),
    lockType: String(r.lock_type),
    lockMode: String(r.lock_mode),
    relation: r.relation ? String(r.relation) : null,
    blockedBy: Array.isArray(r.blocked_by) ? (r.blocked_by as unknown[]).map(Number) : [],
    query: normalizeSql(String(r.query ?? "")),
  }));
}

/**
 * Двадцать пять самых больших таблиц: размер с индексами, оценка строк из
 * статистики планировщика (не count(*) — на большой базе он сам нагрузка),
 * мёртвые строки и когда их последний раз убирала автоочистка.
 */
async function readTables(probe: Probe): Promise<OpsTableStat[]> {
  const rows = await probe(sql`
    select c.relname                            as "table",
           pg_total_relation_size(c.oid)::bigint as total,
           pg_relation_size(c.oid)::bigint       as heap,
           pg_indexes_size(c.oid)::bigint        as idx,
           s.n_live_tup                          as live,
           s.n_dead_tup                          as dead,
           s.seq_scan                            as seq_scan,
           s.idx_scan                            as idx_scan,
           s.last_autovacuum                     as last_autovacuum,
           s.last_autoanalyze                    as last_autoanalyze
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_stat_user_tables s on s.relid = c.oid
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by pg_total_relation_size(c.oid) desc
    limit 25
  `);
  return rows.map((r) => ({
    table: String(r.table),
    totalBytes: Number(r.total),
    tableBytes: Number(r.heap),
    indexBytes: Number(r.idx),
    liveRows: num(r.live),
    deadRows: num(r.dead),
    seqScan: num(r.seq_scan),
    idxScan: num(r.idx_scan),
    lastAutovacuum: iso(r.last_autovacuum),
    lastAutoanalyze: iso(r.last_autoanalyze),
  }));
}

const JOURNAL = (journal as { entries: { idx: number; when: number; tag: string }[] }).entries;

/**
 * Миграции: последние десять применённых и сколько из журнала ещё нет.
 *
 * drizzle хранит в своей таблице хэш и метку `when` из журнала, но не имя —
 * имя находится по метке в apps/api/drizzle/meta/_journal.json, том самом,
 * что едет в образе вместе с кодом. «Не применено N» здесь значит ровно то,
 * что код новее схемы: provision не отработал или отработал на другую базу.
 */
async function readMigrations(probe: Probe): Promise<NonNullable<OpsDb["migrations"]>> {
  const rows = await probe(sql`
    select created_at::bigint as at,
           (select count(*)::int from drizzle.__drizzle_migrations) as applied
    from drizzle.__drizzle_migrations
    order by created_at desc
    limit 10
  `);
  const byWhen = new Map(JOURNAL.map((e) => [e.when, e]));
  const applied: OpsMigration[] = rows.map((r) => {
    const at = Number(r.at);
    const entry = byWhen.get(at);
    return { idx: entry?.idx ?? null, tag: entry?.tag ?? null, at: new Date(at).toISOString() };
  });
  const newest = rows.length ? Number(rows[0]!.at) : 0;
  return {
    applied,
    appliedCount: rows.length ? Number(rows[0]!.applied) : 0,
    known: JOURNAL.length,
    pending: JOURNAL.filter((e) => e.when > newest).length,
  };
}

async function readSize(probe: Probe): Promise<number> {
  const [row] = await probe(sql`select pg_database_size(current_database())::bigint as bytes`);
  return Number(row?.bytes ?? 0);
}

/** Весь раздел «База» */
export async function collectDb(probe: Probe = liveProbe): Promise<OpsDb> {
  const notes: OpsDbNote[] = [];

  const size = await attempt("size", () => readSize(probe));
  if (!size.ok) notes.push("sizeFailed");

  const tables = await attempt("tables", () => readTables(probe));
  if (!tables.ok) notes.push("tablesFailed");

  /*
   * Подключения и долгие запросы — из одного pg_stat_activity: если на него
   * нет прав, пояснение одно на оба раздела, а не два одинаковых.
   */
  const conns = await attempt("connections", () => readConnections(probe));
  const long = await attempt("longQueries", () => readLongQueries(probe));
  if (!conns.ok || !long.ok) notes.push("activityDenied");
  else if (conns.value.hidden) notes.push("activityPartial");

  const locks = await attempt("locks", () => readLocks(probe));
  if (!locks.ok) notes.push("locksFailed");

  const migrations = await attempt("migrations", () => readMigrations(probe));
  if (!migrations.ok) notes.push("migrationsDenied");

  return {
    bytes: size.ok ? size.value : null,
    tables: tables.ok ? tables.value : null,
    connections: conns.ok ? conns.value.value : null,
    longQueries: long.ok ? long.value : null,
    locks: locks.ok ? locks.value : null,
    migrations: migrations.ok ? migrations.value : null,
    notes,
  };
}

/** Короткая справка о базе для обзора: без таблиц и блокировок */
export async function dbSummary(probe: Probe = liveProbe) {
  const started = performance.now();
  const ping = await attempt("ping", () => probe(sql`select 1 as ok`));
  const latencyMs = ping.ok ? Math.round((performance.now() - started) * 10) / 10 : null;
  const size = await attempt("size", () => readSize(probe));
  const conns = await attempt("connections", () => readConnections(probe));
  const migrations = await attempt("migrations", () => readMigrations(probe));
  const last = migrations.ok ? migrations.value.applied[0] : undefined;
  return {
    up: ping.ok,
    latencyMs,
    bytes: size.ok ? size.value : null,
    connections: conns.ok ? conns.value.value : null,
    lastMigration: last ? { tag: last.tag, idx: last.idx } : null,
    pendingMigrations: migrations.ok ? migrations.value.pending : null,
    knownMigrations: JOURNAL.length,
  };
}
