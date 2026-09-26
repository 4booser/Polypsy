/**
 * Чтение истории техпанели: логи и ошибки за период — из базы, склеенные с
 * живым хвостом из памяти процесса без дублей.
 *
 * Решение заказчика 2026-09-26: вкладки «Логи» и «Помилки» переходят на
 * историю из базы, «з моменту запуску» уступает место настоящему периоду.
 *
 * Склейка. В базе — то, что уже записано (lib/opsStore.ts, пачкой раз в
 * десять секунд, с любой реплики). В памяти этого процесса — последние
 * строки, часть которых ещё не записана. Строка однозначно названа парой
 * «экземпляр процесса + номер буфера», и по ней две половины склеиваются:
 * одна и та же строка, пришедшая и из базы, и из памяти, — одна строка.
 * Ошибки склеиваются по отпечатку: к сохранённому счёту прибавляется ещё
 * не записанное приращение.
 *
 * Чтение — в контексте смотрящего и в своей точке сохранения (liveProbe):
 * политика строк пускает держателей ops.read, а отказ базы не роняет
 * ответ — экран получает память процесса и пометку, что истории нет.
 */
import { sql, type SQL } from "drizzle-orm";
import type { OpsErrorGroup, OpsErrorWindow, OpsLevel, OpsLogLine, OpsLogWindow } from "@quizzy/shared";
import { attempt, liveProbe, type Probe } from "./opsDb";
import { readLogs } from "./opsBuffer";
import { pendingErrorGroups } from "./opsStore";

const DAY = 86_400_000;

export const LOG_WINDOW_MS: Record<OpsLogWindow, number> = {
  "1h": 3_600_000,
  "24h": DAY,
  "7d": 7 * DAY,
  "14d": 14 * DAY,
};

export const ERROR_WINDOW_MS: Record<OpsErrorWindow, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
};

const LEVELS: readonly OpsLevel[] = ["debug", "info", "warn", "error"];

/* ─────────── курсор ─────────── */

/** Место строки в ленте: момент, экземпляр, номер */
export interface LineKey {
  at: string;
  instance: string;
  seq: number;
}

/** Курсор «старше этой строки» в адресе: `<мс>-<экземпляр>-<номер>` */
export function encodeCursor(k: LineKey): string {
  return `${Date.parse(k.at)}-${k.instance}-${k.seq}`;
}

export function decodeCursor(raw: string | undefined): LineKey | null {
  if (!raw) return null;
  const m = /^(\d{1,15})-([0-9a-f]{0,16})-(\d{1,15})$/.exec(raw);
  if (!m) return null;
  return { at: new Date(Number(m[1])).toISOString(), instance: m[2]!, seq: Number(m[3]) };
}

/*
 * Порядок ленты: новее — раньше. Экземпляр сравнивается побайтно, а не по
 * правилам языка: база сортирует его так же (шестнадцатеричные знаки), и
 * граница страницы в базе и в памяти обязана проходить по одному месту.
 */
const byteCmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function compareDesc(a: LineKey, b: LineKey): number {
  return byteCmp(b.at, a.at) || byteCmp(b.instance, a.instance) || b.seq - a.seq;
}

const keyOf = (l: OpsLogLine): LineKey => ({ at: l.at, instance: l.instance ?? "", seq: l.seq });
const idOf = (l: OpsLogLine) => `${l.instance ?? ""}:${l.seq}`;

/** Строка лога из строки базы */
export function lineFromRow(r: Record<string, unknown>): OpsLogLine {
  return {
    seq: Number(r.seq),
    at: new Date(r.at as string).toISOString(),
    level: String(r.level) as OpsLevel,
    message: String(r.message),
    requestId: r.request_id ? String(r.request_id) : null,
    fields: (r.fields ?? {}) as Record<string, unknown>,
    instance: String(r.instance ?? ""),
    fingerprint: r.fingerprint ? String(r.fingerprint) : null,
  };
}

/**
 * Слить историю и память: без повторов, новые первыми, не больше `limit`.
 * `more` — в источниках осталось что-то за границей страницы.
 */
export function mergeHistory(
  stored: readonly OpsLogLine[],
  memory: readonly OpsLogLine[],
  limit: number,
  storedHasMore: boolean,
): { items: OpsLogLine[]; more: boolean } {
  const seen = new Map<string, OpsLogLine>();
  for (const l of stored) seen.set(idOf(l), l);
  for (const l of memory) if (!seen.has(idOf(l))) seen.set(idOf(l), l);
  const all = [...seen.values()].sort((a, b) => compareDesc(keyOf(a), keyOf(b)));
  return { items: all.slice(0, limit), more: storedHasMore || all.length > limit };
}

/* ─────────── логи ─────────── */

export interface LogHistoryQuery {
  window: OpsLogWindow;
  level?: OpsLevel;
  q?: string;
  requestId?: string;
  before?: string;
  limit?: number;
}

export interface LogHistoryPage {
  /** По возрастанию, как у живой ленты */
  items: OpsLogLine[];
  from: string;
  older: string | null;
  failed: boolean;
}

/** `_` и `%` в номере запроса — знаки, а не шаблон LIKE */
const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, "\\$&")}%`;

export async function readLogHistory(query: LogHistoryQuery, probe: Probe = liveProbe, now = Date.now()): Promise<LogHistoryPage> {
  const limit = Math.max(1, Math.min(1000, query.limit ?? 300));
  const from = new Date(now - LOG_WINDOW_MS[query.window]).toISOString();
  const before = decodeCursor(query.before);
  const min = LEVELS.indexOf(query.level ?? "debug");
  const levels = LEVELS.slice(Math.max(0, min));
  const needle = query.q?.trim().toLowerCase() || null;
  const rid = query.requestId?.trim() || null;

  const conds: SQL[] = [sql`at >= ${from}`, sql`level in (${sql.join(levels.map((l) => sql`${l}`), sql`, `)})`];
  if (before) conds.push(sql`(at, instance, seq) < (${before.at}::timestamptz, ${before.instance}, ${before.seq}::bigint)`);
  /* номер укороченным — так его печатает лог разработки; от восьми знаков, как в памяти */
  if (rid) conds.push(rid.length >= 8 ? sql`(request_id = ${rid} or request_id like ${likePrefix(rid)})` : sql`request_id = ${rid}`);
  if (needle) conds.push(sql`strpos(lower(message || ' ' || fields::text), ${needle}) > 0`);

  const stored = await attempt("logHistory", () =>
    probe(sql`
      select instance, seq, at, level, message, request_id, fingerprint, fields
      from ops_log_lines
      where ${sql.join(conds, sql` and `)}
      order by at desc, instance desc, seq desc
      limit ${limit + 1}
    `),
  );
  const storedLines = stored.ok ? stored.value.slice(0, limit).map(lineFromRow) : [];
  const storedHasMore = stored.ok && stored.value.length > limit;

  /* память: тот же отбор, что у живой ленты, плюс границы периода и страницы */
  const memory = readLogs({ level: query.level, q: query.q, requestId: query.requestId, limit: 1000 }).items.filter(
    (l) => l.at >= from && (!before || compareDesc(keyOf(l), before) > 0),
  );

  const { items, more } = mergeHistory(storedLines, memory, limit, storedHasMore);
  const last = items.at(-1);
  return {
    items: items.reverse(),
    from,
    older: more && last ? encodeCursor(keyOf(last)) : null,
    failed: !stored.ok,
  };
}

/* ─────────── ошибки ─────────── */

const iso = (v: unknown) => new Date(v as string).toISOString();

function groupFromRow(r: Record<string, unknown>): OpsErrorGroup {
  return {
    fingerprint: String(r.fingerprint),
    origin: r.origin === "log" ? "log" : "request",
    name: String(r.name),
    message: String(r.message),
    method: r.method ? String(r.method) : null,
    route: r.route ? String(r.route) : null,
    code: r.code === null || r.code === undefined ? null : Number(r.code),
    count: Number(r.n ?? r.total ?? 0),
    totalCount: Number(r.total ?? 0),
    firstAt: iso(r.first_at),
    lastAt: iso(r.last_at),
    lastRequestId: r.last_request_id ? String(r.last_request_id) : null,
    frames: Array.isArray(r.frames) ? (r.frames as unknown[]).map(String) : [],
  };
}

const GROUP_COLS = sql`g.fingerprint, g.origin, g.name, g.message, g.method, g.route, g.code, g.count as total,
  g.first_at, g.last_at, g.last_request_id, g.frames`;

/**
 * Сохранённые группы плюс ещё не записанное приращение. Приращение
 * прибавляется и к счёту периода, и ко «всего»; момент последнего случая —
 * позднейший из двух, первого — ранний.
 */
export function mergeErrorGroups(
  stored: readonly OpsErrorGroup[],
  pending: readonly (OpsErrorGroup & { hours: [number, number][] })[],
  fromHourMs: number,
): OpsErrorGroup[] {
  const by = new Map(stored.map((g) => [g.fingerprint, { ...g, frames: g.frames.slice() }]));
  for (const p of pending) {
    const inPeriod = p.hours.reduce((s, [h, n]) => (h >= fromHourMs ? s + n : s), 0);
    const known = by.get(p.fingerprint);
    if (!known) {
      if (!inPeriod) continue;
      const { hours: _h, ...g } = p;
      by.set(p.fingerprint, { ...g, count: inPeriod, totalCount: p.count });
      continue;
    }
    known.count += inPeriod;
    known.totalCount = (known.totalCount ?? known.count) + p.count;
    if (p.firstAt < known.firstAt) known.firstAt = p.firstAt;
    if (p.lastAt >= known.lastAt) {
      known.lastAt = p.lastAt;
      known.lastRequestId = p.lastRequestId ?? known.lastRequestId;
    }
    if (!known.frames.length && p.frames.length) known.frames = p.frames.slice();
  }
  return [...by.values()].filter((g) => g.count > 0).sort((a, b) => byteCmp(b.lastAt, a.lastAt));
}

export async function readErrorHistory(
  window: OpsErrorWindow,
  probe: Probe = liveProbe,
  now = Date.now(),
): Promise<{ items: OpsErrorGroup[]; from: string; failed: boolean }> {
  const fromMs = now - ERROR_WINDOW_MS[window];
  /* счёт за период — по часовым корзинам: граница периода округлена до часа вниз */
  const fromHour = Math.floor(fromMs / 3_600_000) * 3_600_000;
  const stored = await attempt("errorHistory", () =>
    probe(sql`
      select ${GROUP_COLS}, h.n
      from ops_error_groups g
      join (
        select fingerprint, sum(count)::bigint as n
        from ops_error_hours
        where hour >= ${new Date(fromHour).toISOString()}
        group by fingerprint
      ) h on h.fingerprint = g.fingerprint
      order by g.last_at desc
      limit 500
    `),
  );
  const storedGroups = stored.ok ? stored.value.map(groupFromRow) : [];

  /*
   * Группа, которая есть в базе, но в периоде случаев не имела и
   * повторилась только что (приращение ещё в очереди), — нужна целиком: с
   * первым появлением и общим счётом.
   */
  const pending = pendingErrorGroups();
  const missing = pending.map((p) => p.fingerprint).filter((f) => !storedGroups.some((g) => g.fingerprint === f));
  if (stored.ok && missing.length) {
    const extra = await attempt("errorHistoryExtra", () =>
      probe(sql`
        select ${GROUP_COLS}, 0 as n from ops_error_groups g
        where g.fingerprint in (${sql.join(missing.map((f) => sql`${f}`), sql`, `)})
      `),
    );
    if (extra.ok) storedGroups.push(...extra.value.map(groupFromRow));
  }

  return {
    items: mergeErrorGroups(storedGroups, pending, fromHour),
    from: new Date(fromMs).toISOString(),
    failed: !stored.ok,
  };
}

/** Группы по отпечаткам — для трассы запроса: сохранённые плюс очередь */
export async function errorGroupsByFingerprint(fingerprints: readonly string[], probe: Probe = liveProbe): Promise<OpsErrorGroup[]> {
  if (!fingerprints.length) return [];
  const stored = await attempt("errorGroups", () =>
    probe(sql`
      select ${GROUP_COLS}, g.count as n from ops_error_groups g
      where g.fingerprint in (${sql.join(fingerprints.map((f) => sql`${f}`), sql`, `)})
    `),
  );
  const pending = pendingErrorGroups().filter((p) => fingerprints.includes(p.fingerprint));
  /* всё время: граница периода — ноль, в счёт идёт каждый час приращения */
  return mergeErrorGroups(stored.ok ? stored.value.map(groupFromRow) : [], pending, 0);
}
