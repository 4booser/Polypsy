/**
 * Сравнение выкаток: время ответа и ошибки по маршрутам за час до и после.
 *
 * Решение заказчика 2026-09-26: «сравнение до и после выкатки — время ответа
 * и ошибки по маршрутам за час до и после». Суммы запросов пишутся с меткой
 * версии (QUIZZY_VERSION, lib/opsStore.ts → releaseTag), и выкатка — это
 * смена метки: первая минута, в которой появилась новая версия.
 *
 * Окна. «После» — первый час данных новой версии. «До» — последний час
 * данных старой, закончившийся не позже появления новой. Так пара соседних
 * версий сравнивается ровно по границе выкатки, а пара несоседних (выбрали
 * вручную) — каждая своим последним / первым часом, и сравнение не
 * превращается в «час, когда старой версии уже не было».
 *
 * Поминутные суммы живут две недели; для старших выкаток окно берётся по
 * почасовым корзинам — ответ говорит об этом (grain: "hour"), и экран
 * предупреждает, что граница размыта до часа.
 *
 * Сдвиг. Ни «выросло на 40 %», ни «упало» не говорится там, где запросов
 * мало: p95 по десяти запросам — это почти максимум, одиночный выброс, а
 * доля ошибок по трём запросам — 0 или 33 %. Меньше MIN_SAMPLE запросов с
 * любой стороны — «замало запитів», и никаких процентов.
 */
import { sql } from "drizzle-orm";
import type { OpsCompareStats, OpsRelease, OpsReleaseCompare, OpsReleaseSide, OpsRouteCompare, OpsShift } from "@quizzy/shared";
import { LATENCY_BUCKETS } from "./metrics";
import { quantile } from "./opsBuffer";
import { attempt, liveProbe, type Probe } from "./opsDb";
import { HOUR_RETENTION_DAYS, pendingAggRows, releaseTag, type AggRow } from "./opsStore";

/** Окно сравнения, минуты: час до и час после, как просил заказчик */
export const COMPARE_WINDOW_MIN = 60;

/**
 * Меньше тридцати запросов с любой стороны — сравнивать нечего. p95 по
 * тридцати — второе по величине значение, и это ещё осмысленно; по
 * двадцати — уже максимум, то есть одиночный выброс вместо перцентиля.
 */
export const MIN_SAMPLE = 30;

/**
 * p95 «заметно» вырос — на четверть И не меньше чем на 50 мс. Одно
 * отношение поймало бы шум быстрых маршрутов (4 → 6 мс — это +50 %, и
 * никому не важно), одна разница — шум медленных (2000 → 2060 мс — это
 * ничего). Четверть — больше, чем даёт интерполяция внутри одной корзины
 * времени, по которым считается перцентиль (lib/metrics.ts).
 */
export const P95_RATIO = 1.25;
export const P95_MIN_MS = 50;

/**
 * Доля 5xx «заметно» выросла — на процентный пункт (порог оповещения из
 * RUNBOOK и проверки здоровья на обзоре) И пятисоток после выкатки не
 * меньше трёх: одна-две пятисотки на тридцати запросах — это уже
 * несколько процентов, но ещё не вывод.
 */
export const ERROR_PP = 0.01;
export const ERROR_MIN = 3;

const MINUTE = 60_000;
const HOUR = 3_600_000;

interface Sum {
  count: number;
  c4: number;
  c5: number;
  sum: number;
  max: number;
  hist: number[];
}

const emptySum = (): Sum => ({ count: 0, c4: 0, c5: 0, sum: 0, max: 0, hist: new Array(LATENCY_BUCKETS.length + 1).fill(0) });

function addSum(into: Sum, r: { count: number; c4: number; c5: number; sum: number; max: number; hist: readonly number[] }) {
  into.count += r.count;
  into.c4 += r.c4;
  into.c5 += r.c5;
  into.sum += r.sum;
  if (r.max > into.max) into.max = r.max;
  for (let i = 0; i < into.hist.length; i++) into.hist[i]! += r.hist[i] ?? 0;
}

export function statsOfSum(s: Sum): OpsCompareStats {
  return {
    requests: s.count,
    errors5xx: s.c5,
    share5xx: s.count ? s.c5 / s.count : null,
    p50: quantile(s.hist, 0.5, s.max),
    p95: quantile(s.hist, 0.95, s.max),
  };
}

/* ─────────── сдвиг ─────────── */

export function latencyShift(b: OpsCompareStats | null, a: OpsCompareStats | null): OpsShift {
  if (!b || !a || b.requests < MIN_SAMPLE || a.requests < MIN_SAMPLE || b.p95 === null || a.p95 === null) return "few";
  const diff = a.p95 - b.p95;
  if (diff >= P95_MIN_MS && a.p95 >= b.p95 * P95_RATIO) return "worse";
  if (-diff >= P95_MIN_MS && b.p95 >= a.p95 * P95_RATIO) return "better";
  return "same";
}

export function errorShift(b: OpsCompareStats | null, a: OpsCompareStats | null): OpsShift {
  if (!b || !a || b.requests < MIN_SAMPLE || a.requests < MIN_SAMPLE) return "few";
  const d = (a.share5xx ?? 0) - (b.share5xx ?? 0);
  if (d >= ERROR_PP - 1e-9 && a.errors5xx >= ERROR_MIN) return "worse";
  if (-d >= ERROR_PP - 1e-9 && b.errors5xx >= ERROR_MIN) return "better";
  return "same";
}

const rank = (s: OpsShift) => (s === "worse" ? 0 : s === "better" ? 1 : s === "same" ? 2 : 3);

/**
 * Маршруты двух окон рядом. Порядок: сначала то, что ухудшилось, потом
 * улучшилось, потом без изменений, потом «замало»; внутри — по числу
 * запросов после выкатки: ухудшение на нагруженном маршруте важнее.
 */
export function compareRoutes(before: ReadonlyMap<string, Sum>, after: ReadonlyMap<string, Sum>): OpsRouteCompare[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const items: OpsRouteCompare[] = [];
  for (const key of keys) {
    const sp = key.indexOf(" ");
    const b = before.get(key);
    const a = after.get(key);
    const bs = b ? statsOfSum(b) : null;
    const as = a ? statsOfSum(a) : null;
    items.push({
      method: key.slice(0, sp),
      route: key.slice(sp + 1),
      before: bs,
      after: as,
      latency: latencyShift(bs, as),
      errors: errorShift(bs, as),
    });
  }
  return items.sort(
    (x, y) =>
      Math.min(rank(x.latency), rank(x.errors)) - Math.min(rank(y.latency), rank(y.errors)) ||
      (y.after?.requests ?? 0) - (x.after?.requests ?? 0) ||
      (y.before?.requests ?? 0) - (x.before?.requests ?? 0) ||
      `${x.method} ${x.route}`.localeCompare(`${y.method} ${y.route}`),
  );
}

/* ─────────── версии ─────────── */

interface Span {
  version: string;
  minuteFirst: number | null;
  minuteLast: number | null;
  hourFirst: number | null;
  hourLast: number | null;
  requests: number;
}

const ms = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).getTime());

async function spans(probe: Probe): Promise<Map<string, Span> | null> {
  const hours = await attempt("releasesHour", () =>
    probe(sql`
      select version, min(bucket) as first, max(bucket) as last, sum(count)::bigint as n
      from ops_request_aggs where grain = 'hour' group by version
    `),
  );
  const minutes = await attempt("releasesMinute", () =>
    probe(sql`
      select version, min(bucket) as first, max(bucket) as last
      from ops_request_aggs where grain = 'minute' group by version
    `),
  );
  if (!hours.ok || !minutes.ok) return null;
  const out = new Map<string, Span>();
  const at = (v: string) => {
    let s = out.get(v);
    if (!s) {
      s = { version: v, minuteFirst: null, minuteLast: null, hourFirst: null, hourLast: null, requests: 0 };
      out.set(v, s);
    }
    return s;
  };
  for (const r of hours.value) {
    const s = at(String(r.version));
    s.hourFirst = ms(r.first);
    s.hourLast = ms(r.last);
    s.requests += Number(r.n);
  }
  for (const r of minutes.value) {
    const s = at(String(r.version));
    s.minuteFirst = ms(r.first);
    s.minuteLast = ms(r.last);
  }
  /* ещё не записанное: без него только что выкаченная версия появилась бы через такт записи */
  for (const p of pendingAggRows()) {
    const s = at(p.version);
    const m = p.minute * MINUTE;
    const h = Math.floor(m / HOUR) * HOUR;
    s.minuteFirst = s.minuteFirst === null ? m : Math.min(s.minuteFirst, m);
    s.minuteLast = s.minuteLast === null ? m : Math.max(s.minuteLast, m);
    s.hourFirst = s.hourFirst === null ? h : Math.min(s.hourFirst, h);
    s.hourLast = s.hourLast === null ? h : Math.max(s.hourLast, h);
    s.requests += p.count;
  }
  return out;
}

function releaseOf(s: Span, now: number): OpsRelease {
  const first = s.minuteFirst ?? s.hourFirst ?? now;
  const last = s.minuteLast !== null ? s.minuteLast + MINUTE : Math.min((s.hourLast ?? now) + HOUR, now);
  return { version: s.version, firstAt: new Date(first).toISOString(), lastAt: new Date(last).toISOString(), requests: s.requests };
}

export async function listReleases(probe: Probe = liveProbe, now = Date.now()) {
  const all = await spans(probe);
  const items = all
    ? [...all.values()].map((s) => releaseOf(s, now)).sort((a, b) => b.firstAt.localeCompare(a.firstAt) || a.version.localeCompare(b.version))
    : [];
  return { current: releaseTag(), items: items.slice(0, 60), retentionDays: HOUR_RETENTION_DAYS, failed: all === null };
}

/* ─────────── сравнение ─────────── */

async function sumsOf(
  probe: Probe,
  grain: "minute" | "hour",
  version: string,
  from: number,
  to: number,
): Promise<{ byRoute: Map<string, Sum>; total: number } | null> {
  const rows = await attempt("compareRows", () =>
    probe(sql`
      select method, route, count, c4, c5, sum_ms, max_ms, hist
      from ops_request_aggs
      where grain = ${grain} and version = ${version}
        and bucket >= ${new Date(from).toISOString()} and bucket < ${new Date(to).toISOString()}
    `),
  );
  if (!rows.ok) return null;
  const byRoute = new Map<string, Sum>();
  let total = 0;
  const add = (method: string, route: string, r: Parameters<typeof addSum>[1]) => {
    const key = `${method} ${route}`;
    let s = byRoute.get(key);
    if (!s) {
      s = emptySum();
      byRoute.set(key, s);
    }
    addSum(s, r);
    total += r.count;
  };
  for (const r of rows.value) {
    add(String(r.method), String(r.route), {
      count: Number(r.count),
      c4: Number(r.c4),
      c5: Number(r.c5),
      sum: Number(r.sum_ms),
      max: Number(r.max_ms),
      hist: (r.hist as unknown[]).map(Number),
    });
  }
  for (const p of pendingAggRows() as AggRow[]) {
    if (p.version !== version) continue;
    const m = p.minute * MINUTE;
    const b = grain === "minute" ? m : Math.floor(m / HOUR) * HOUR;
    if (b >= from && b < to) add(p.method, p.route, p);
  }
  return { byRoute, total };
}

/**
 * Пара версий и их окна. `after` по умолчанию — версия этого процесса,
 * если о ней уже есть данные, иначе самая новая; `before` — предыдущая по
 * времени появления.
 */
export async function compareReleases(
  q: { before?: string; after?: string },
  probe: Probe = liveProbe,
  now = Date.now(),
): Promise<OpsReleaseCompare & { failed: boolean }> {
  const base: OpsReleaseCompare = {
    before: null,
    after: null,
    grain: "minute",
    windowMin: COMPARE_WINDOW_MIN,
    thresholds: { minSample: MIN_SAMPLE, p95Ratio: P95_RATIO, p95MinMs: P95_MIN_MS, errorPp: ERROR_PP, errorMin: ERROR_MIN },
    items: [],
  };
  const all = await spans(probe);
  if (!all) return { ...base, failed: true };
  const ordered = [...all.values()].sort((a, b) => (a.minuteFirst ?? a.hourFirst ?? 0) - (b.minuteFirst ?? b.hourFirst ?? 0));

  const afterV = q.after && all.has(q.after) ? q.after : all.has(releaseTag()) ? releaseTag() : ordered.at(-1)?.version;
  if (!afterV) return { ...base, failed: false };
  const after = all.get(afterV)!;
  const beforeV =
    q.before && all.has(q.before)
      ? q.before
      : ordered
          .filter((s) => s.version !== afterV && (s.minuteFirst ?? s.hourFirst ?? 0) < (after.minuteFirst ?? after.hourFirst ?? 0))
          .at(-1)?.version;
  if (!beforeV || beforeV === afterV) return { ...base, after: sideOf(after, now), failed: false };
  const before = all.get(beforeV)!;

  /* поминутно — если минутные суммы есть у обеих; иначе по часам */
  const grain: "minute" | "hour" = after.minuteFirst !== null && before.minuteLast !== null ? "minute" : "hour";
  const step = grain === "minute" ? MINUTE : HOUR;
  const window = grain === "minute" ? COMPARE_WINDOW_MIN * MINUTE : Math.max(HOUR, COMPARE_WINDOW_MIN * MINUTE);
  const afterFirst = (grain === "minute" ? after.minuteFirst : after.hourFirst) ?? now;
  const beforeFirst = (grain === "minute" ? before.minuteFirst : before.hourFirst) ?? 0;
  const beforeLastEnd = ((grain === "minute" ? before.minuteLast : before.hourLast) ?? 0) + step;
  const beforeEnd = beforeFirst < afterFirst ? Math.min(beforeLastEnd, afterFirst) : beforeLastEnd;
  const beforeStart = Math.max(beforeEnd - window, beforeFirst);
  const afterEnd = afterFirst + window;

  const b = await sumsOf(probe, grain, beforeV, beforeStart, beforeEnd);
  const a = await sumsOf(probe, grain, afterV, afterFirst, afterEnd);
  if (!b || !a) return { ...base, failed: true };

  const side = (version: string, from: number, to: number, requests: number): OpsReleaseSide => ({
    version,
    from: new Date(from).toISOString(),
    to: new Date(Math.min(to, now)).toISOString(),
    requests,
  });
  return {
    ...base,
    grain,
    before: side(beforeV, beforeStart, beforeEnd, b.total),
    after: side(afterV, afterFirst, afterEnd, a.total),
    items: compareRoutes(b.byRoute, a.byRoute),
    failed: false,
  };
}

/** Сторона без пары — единственная версия: весь её срок, сравнивать не с чем */
function sideOf(s: Span, now: number): OpsReleaseSide {
  const r = releaseOf(s, now);
  return { version: s.version, from: r.firstAt, to: r.lastAt, requests: s.requests };
}
