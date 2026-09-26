/**
 * Трасса одного запроса по номеру: всё, что система знает об одном
 * обращении, на одной странице.
 *
 * Решение заказчика 2026-09-26: «/ops/trace/:requestId — все записи лога
 * этого запроса по порядку, ошибка (если была), строки audit_log с этим
 * requestId, SQL этого запроса, итог — маршрут, статус, длительность, роль».
 * Человек называет номер с экрана ошибки — разработчик открывает одну
 * страницу, а не четыре вкладки и psql.
 *
 * Откуда что:
 *   — строки лога: история в базе (ops_log_lines) плюс память процесса,
 *     склеенные по «экземпляр + номер» (lib/opsHistory.ts);
 *   — итог: строка «request» того же лога — маршрут шаблоном, код, время,
 *     роль, число и время SQL (middleware/requestId.ts);
 *   — ошибка: строки уровня error несут отпечаток группы (opsBuffer.ts),
 *     группа — из базы и очереди записи;
 *   — журнал: audit.ts кладёт номер запроса в details.requestId каждой
 *     записи — колонки нет и не будет (она изменила бы хэш-цепочку, см.
 *     комментарий в audit.ts), ищется по details в окне времени вокруг
 *     запроса, и индекс по `at` делает поиск дешёвым;
 *   — SQL: тексты — из памяти последних запросов (lib/opsSql.ts), у
 *     медленных и упавших — сохранённые со строкой «request».
 *
 * Чужого трасса не собирает: всё отбирается по точному номеру. Номер,
 * заданный началом (так его печатает лог разработки), — только если он
 * однозначен; иначе экран получает список кандидатов.
 *
 * Из журнала на экран идёт действие, исход, вид ресурса и роль — без
 * почты, адресатов и подробностей: право ops.read не открывает людей, а
 * подробности записи — дело права audit.read и вкладки аудита.
 */
import { sql, type SQL } from "drizzle-orm";
import type { OpsErrorGroup, OpsLogLine, OpsTrace, OpsTraceAudit, OpsTraceSql, OpsTraceSummary, Role } from "@quizzy/shared";
import { db } from "../db";
import { asSystem } from "../db/context";
import { attempt, liveProbe, normalizeSql, type Probe } from "./opsDb";
import { errorGroupList, readLogs } from "./opsBuffer";
import { compareDesc, errorGroupsByFingerprint, lineFromRow } from "./opsHistory";
import { requestSql } from "./opsSql";
import { LOG_RETENTION_DAYS } from "./opsStore";

/** Журнал — системным контекстом: политика audit_log шире не станет, а отдаётся только безличное */
export const systemAuditProbe: Probe = (query: SQL) =>
  db.transaction(() => asSystem(async () => (await db.execute(query)) as unknown as Record<string, unknown>[]));

const ROLES: readonly Role[] = ["superadmin", "admin", "user"];
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Итог — из строки «request»; её поля пишет промежуточный слой запроса */
export function summaryOf(lines: readonly OpsLogLine[]): OpsTraceSummary | null {
  const req = [...lines].reverse().find((l) => l.message === "request");
  if (!req) return null;
  const f = req.fields;
  return {
    at: req.at,
    method: typeof f.method === "string" ? f.method : null,
    route: typeof f.path === "string" ? f.path : null,
    status: num(f.status),
    ms: num(f.ms),
    role: ROLES.includes(f.role as Role) ? (f.role as Role) : null,
    sqlCount: num(f.sql),
    sqlMs: num(f.sqlMs),
  };
}

const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, "\\$&")}%`;

async function linesOf(id: string, probe: Probe): Promise<{ lines: OpsLogLine[]; storedSql: unknown }> {
  const stored = await attempt("traceLines", () =>
    probe(sql`
      select instance, seq, at, level, message, request_id, fingerprint, fields, sql
      from ops_log_lines where request_id = ${id}
      order by at, instance, seq
      limit 500
    `),
  );
  const rows = stored.ok ? stored.value : [];
  const seen = new Map<string, OpsLogLine>();
  for (const r of rows) {
    const l = lineFromRow(r);
    seen.set(`${l.instance}:${l.seq}`, l);
  }
  for (const l of readLogs({ requestId: id, limit: 1000 }).items) {
    if (l.requestId !== id) continue;
    const k = `${l.instance ?? ""}:${l.seq}`;
    if (!seen.has(k)) seen.set(k, l);
  }
  const lines = [...seen.values()].sort((a, b) =>
    compareDesc({ at: b.at, instance: b.instance ?? "", seq: b.seq }, { at: a.at, instance: a.instance ?? "", seq: a.seq }),
  );
  const reqRow = rows.find((r) => r.message === "request" && r.sql);
  return { lines, storedSql: reqRow?.sql ?? null };
}

/** Номера запросов, начинающиеся с данного: из базы и из памяти */
async function candidatesOf(prefix: string, probe: Probe): Promise<string[]> {
  const out = new Set<string>();
  const stored = await attempt("traceCandidates", () =>
    probe(sql`select distinct request_id from ops_log_lines where request_id like ${likePrefix(prefix)} limit 6`),
  );
  if (stored.ok) for (const r of stored.value) out.add(String(r.request_id));
  for (const l of readLogs({ requestId: prefix, limit: 1000 }).items) {
    if (l.requestId?.startsWith(prefix)) out.add(l.requestId);
  }
  return [...out].sort().slice(0, 6);
}

function sqlOf(id: string, stored: unknown): OpsTraceSql | null {
  const mem = requestSql(id);
  if (mem) return { ...mem, top: mem.top.map((t) => ({ ...t, query: normalizeSql(t.query, 500) })), source: "memory" };
  if (stored && typeof stored === "object") {
    const s = stored as Omit<OpsTraceSql, "source">;
    if (typeof s.count === "number" && Array.isArray(s.top)) return { ...s, source: "stored" };
  }
  return null;
}

/**
 * Записи журнала этого запроса. Окно — час вокруг строк лога: запрос
 * длится секунды, а час с запасом покрывает расхождение часов между
 * процессом и базой. Без строк лога (запрос старше срока их хранения,
 * или его строки не дошли) — последние две недели.
 */
async function auditOf(id: string, lines: readonly OpsLogLine[], probe: Probe): Promise<OpsTraceAudit[] | null> {
  const window = lines.length
    ? sql`at between ${new Date(Date.parse(lines[0]!.at) - 3_600_000).toISOString()}
                  and ${new Date(Date.parse(lines.at(-1)!.at) + 3_600_000).toISOString()}`
    : sql`at > now() - ${`${LOG_RETENTION_DAYS} days`}::interval`;
  const rows = await attempt("traceAudit", () =>
    probe(sql`
      select at, action, outcome, resource_type, actor_role
      from audit_log
      where ${window} and details->>'requestId' = ${id}
      order by at, seq nulls first
      limit 100
    `),
  );
  if (!rows.ok) return null;
  return rows.value.map((r) => ({
    at: new Date(r.at as string).toISOString(),
    action: String(r.action),
    outcome: String(r.outcome),
    resourceType: r.resource_type ? String(r.resource_type) : null,
    actorRole: r.actor_role ? String(r.actor_role) : null,
  }));
}

export async function collectTrace(
  rawId: string,
  probe: Probe = liveProbe,
  auditProbe: Probe = systemAuditProbe,
): Promise<OpsTrace> {
  let id = rawId.trim();
  let { lines, storedSql } = await linesOf(id, probe);
  let candidates: string[] = [];

  if (!lines.length && id.length >= 8) {
    candidates = await candidatesOf(id, probe);
    if (candidates.length === 1) {
      id = candidates[0]!;
      ({ lines, storedSql } = await linesOf(id, probe));
      candidates = [];
    }
  }

  const fingerprints = [...new Set(lines.map((l) => l.fingerprint).filter((f): f is string => Boolean(f)))];
  let errors: OpsErrorGroup[] = await errorGroupsByFingerprint(fingerprints, probe);
  /* группа, которой ещё нет ни в базе, ни в очереди (хранилище не подключено), — из памяти процесса */
  const known = new Set(errors.map((g) => g.fingerprint));
  const fromMemory = errorGroupList().items.filter((g) => fingerprints.includes(g.fingerprint) && !known.has(g.fingerprint));
  errors = [...errors, ...fromMemory];

  return {
    requestId: id,
    candidates,
    summary: summaryOf(lines),
    lines,
    errors,
    audit: candidates.length ? [] : await auditOf(id, lines, auditProbe),
    sql: sqlOf(id, storedSql),
    retentionDays: LOG_RETENTION_DAYS,
  };
}
