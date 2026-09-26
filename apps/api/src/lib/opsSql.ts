/**
 * Счёт SQL одного запроса: сколько запросов к базе, сколько времени, какие
 * тексты самые долгие.
 *
 * Решение заказчика 2026-09-26 (трассировка по номеру запроса): «SQL этого
 * запроса — число запросов и суммарное время, самые медленные». Отвечает на
 * вопрос, который по логу не решить: запрос шёл две секунды — это один
 * тяжёлый SELECT или четыреста лёгких (N+1)?
 *
 * Как устроено. Обёртка вокруг выполнения подготовленного запроса drizzle
 * (PostgresJsPreparedQuery.execute/all) — единственной точки, через которую
 * проходит и построитель запросов, и db.execute(sql`…`), и relational
 * queries, и всё это же внутри транзакции requireAuth. Счёт копится в
 * хранилище запроса из lib/log.ts (AsyncLocalStorage), тем же, что носит
 * номер запроса: «запрос» для лога и для счёта SQL не могут разойтись.
 *
 * Отвергнуто:
 *   — логгер drizzle (logQuery): зовётся ДО выполнения и о времени не знает;
 *   — `debug` postgres.js: то же самое, плюс не видит конца запроса;
 *   — обёртка над клиентом postgres.js (Proxy над sql, begin, savepoint):
 *     запрос у postgres.js ленивый и исполняется по `then`, и любое
 *     «подсмотреть результат» из обёртки запускало бы его раньше, чем
 *     drizzle успел выставить формат строк (.values()).
 *
 * Текст — тот, что уходит драйверу: параметризованный ($1, $2), значений в
 * нём нет. На экран он идёт ещё и через normalizeSql (литералы — «?»),
 * потому что «обычно параметрами» — не гарантия: sql.raw пишет как есть.
 *
 * Вне запроса (планировщик, запись истории техпанели, миграции) счёт не
 * ведётся: хранилища нет, обёртка отдаёт вызов как есть, не засекая время.
 */
import { PostgresJsPreparedQuery } from "drizzle-orm/postgres-js/session";
import type { OpsSqlTop } from "@quizzy/shared";
import { currentRequestScope } from "./log";

interface TextStat {
  calls: number;
  totalMs: number;
  maxMs: number;
}

export interface SqlTally {
  count: number;
  totalMs: number;
  byText: Map<string, TextStat>;
  /** Запросы сверх MAX_TEXTS разных текстов: в число и время входят, в разбивку — нет */
  overflow: number;
}

/*
 * Разных текстов в одном запросе больше двухсот не бывает у исправного
 * маршрута; бывает у сломанного (текст, собранный с литералом внутри, на
 * каждой итерации цикла). Память на такой запрос не должна расти без
 * предела — число и время считаются дальше, разбивка останавливается.
 */
const MAX_TEXTS = 200;

/** Отметить один запрос к базе в счёте текущего запроса; вне запроса — ничего */
export function noteSql(text: string, ms: number): void {
  const scope = currentRequestScope();
  if (!scope) return;
  if (!scope.sql) scope.sql = { count: 0, totalMs: 0, byText: new Map(), overflow: 0 };
  const t = scope.sql;
  t.count++;
  t.totalMs += ms;
  let e = t.byText.get(text);
  if (!e) {
    if (t.byText.size >= MAX_TEXTS) {
      t.overflow++;
      return;
    }
    e = { calls: 0, totalMs: 0, maxMs: 0 };
    t.byText.set(text, e);
  }
  e.calls++;
  e.totalMs += ms;
  if (ms > e.maxMs) e.maxMs = ms;
}

/** Сводка счёта: число, время, разных текстов и самые долгие — текст ещё сырой */
export interface SqlSummary {
  count: number;
  totalMs: number;
  distinct: number;
  top: OpsSqlTop[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export function summarizeSql(t: SqlTally | undefined, top = 10): SqlSummary {
  if (!t) return { count: 0, totalMs: 0, distinct: 0, top: [] };
  const items = [...t.byText.entries()]
    .sort((a, b) => b[1].totalMs - a[1].totalMs)
    .slice(0, top)
    .map(([query, s]) => ({ query, calls: s.calls, totalMs: r1(s.totalMs), maxMs: r1(s.maxMs) }));
  return { count: t.count, totalMs: r1(t.totalMs), distinct: t.byText.size + (t.overflow ? 1 : 0), top: items };
}

/* ─────────── память последних запросов ─────────── */

/*
 * Разбивка SQL последних двух тысяч запросов процесса — для трассы. Число
 * и время уходят в строку «request» лога (и с ней в историю), а тексты —
 * только сюда и, для медленных и упавших запросов, в историю вместе со
 * строкой (lib/opsStore.ts): тексты у каждого запроса — это вдесятеро
 * больше строк в базе ради того, что смотрят раз в неделю.
 */
export const REQUEST_SQL_CAPACITY = 2000;
const recent = new Map<string, SqlSummary>();

export function rememberRequestSql(requestId: string, summary: SqlSummary): void {
  if (!summary.count) return;
  recent.delete(requestId);
  recent.set(requestId, summary);
  if (recent.size > REQUEST_SQL_CAPACITY) {
    const oldest = recent.keys().next().value;
    if (oldest !== undefined) recent.delete(oldest);
  }
}

export function requestSql(requestId: string): SqlSummary | null {
  return recent.get(requestId) ?? null;
}

/** Только для тестов */
export function resetRequestSql(): void {
  recent.clear();
}

/* ─────────── обёртка ─────────── */

type Run = (this: { queryString: string }, ...args: unknown[]) => Promise<unknown>;

let installed = false;

/**
 * Поставить обёртку. Идемпотентно; зовётся при загрузке модуля — модуль
 * грузит промежуточный слой запроса, то есть раньше первого запроса.
 */
export function installSqlTally(): void {
  if (installed) return;
  installed = true;
  const proto = PostgresJsPreparedQuery.prototype as unknown as Record<"execute" | "all", Run>;
  for (const name of ["execute", "all"] as const) {
    const original = proto[name];
    proto[name] = async function (this: { queryString: string }, ...args: unknown[]) {
      if (!currentRequestScope()) return original.apply(this, args);
      const started = performance.now();
      try {
        return await original.apply(this, args);
      } finally {
        noteSql(this.queryString, performance.now() - started);
      }
    };
  }
}

installSqlTally();
