/**
 * История техпанели в базе: логи, группы ошибок, суммы запросов по
 * маршрутам с версией выкатки. Переживает перезапуск и выкатку.
 *
 * Решение заказчика 2026-09-26: «постоянное хранение логов и ошибок с
 * ротацией». До этого память панели жила в кольцевых буферах процесса
 * (lib/opsBuffer.ts), и выкатка стирала её ровно тогда, когда она нужнее
 * всего: после неудачной выкатки спросить «что было до» было не у кого.
 *
 * Как устроено:
 *
 *   — буфер отдаёт сюда каждую запись (приёмник OpsSink), здесь она ложится
 *     в очередь в памяти: строки лога — как есть, запросы — суммами по
 *     минуте и маршруту, ошибки — приращениями по отпечатку. Ни одной
 *     записи в базу на запрос: наблюдение не должно становиться нагрузкой,
 *     которую оно наблюдает;
 *
 *   — раз в FLUSH_MS очередь уходит в базу пачками (flushOpsStore).
 *     Строки лога — вставкой с ON CONFLICT DO NOTHING по «экземпляр +
 *     номер», то есть повтор пачки после обрыва безвреден. Суммы и ошибки —
 *     прибавлением (ON CONFLICT DO UPDATE), одной транзакцией на вид:
 *     прибавление не идемпотентно, и половина пачки, записанная до обрыва,
 *     при повторе посчиталась бы дважды;
 *
 *   — база недоступна — процесс не падает и ничего не теряет, пока хватает
 *     очереди: пачка возвращается в очередь и уходит следующим тактом.
 *     Очередь ограничена (PENDING_LOG_CAP): лог процесса важнее истории
 *     панели, и память под неё расти без предела не должна. Отброшенное
 *     считается и называется на экране;
 *
 *   — ошибка данных (класс 22/23: значение не легло в колонку) — не повод
 *     повторять вечно: такая пачка отброшена с предупреждением, иначе одна
 *     кривая строка остановила бы запись всей истории навсегда.
 *
 * Ротация по сроку — задача планировщика ops.rotate (реестр opsJobs):
 * сроки ниже, с обоснованием. Запись истории идёт на каждой реплике (у
 * каждой свои буферы), ротация — только там, где включён планировщик.
 *
 * Персональных данных сюда не попадает по построению: строки лога уже
 * вычищены буфером (scrub), ошибки — отпечатком без значений, запросы —
 * шаблоном маршрута. Таблицы закрыты политиками строк (0093_ops_history.sql):
 * читать — система и держатели ops.read, писать — только система.
 */
import { sql } from "drizzle-orm";
import type { OpsErrorGroup, OpsLogLine, OpsStoreState } from "@quizzy/shared";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { log } from "./log";
import { LATENCY_BUCKETS } from "./metrics";
import { normalizeSql } from "./opsDb";
import { SLOW_MS, normalizeMessage, setOpsSink, type OpsErrorOccurrence, type RequestSample } from "./opsBuffer";
import { registerJob, trackJob } from "./opsJobs";
import { requestSql } from "./opsSql";

/* ─────────── сроки ─────────── */

/**
 * Строки лога — две недели. Жалобу «на прошлой неделе не сохранилось»
 * приносят через день-три, редко позже недели; две недели покрывают её с
 * запасом на выходные и отпуск разбирающего. Дольше лог — это уже склад со
 * своим местом в бэкапе, а строк здесь больше всего: по одной на запрос.
 */
export const LOG_RETENTION_DAYS = 14;

/**
 * Группы ошибок — девяносто дней. Их мало (строка на отпечаток и строка на
 * час, в котором ошибка была), а вопрос «это уже было?» задают через
 * месяцы: регрессия, вернувшаяся через квартал, должна узнаваться как
 * старая знакомая, с датой первого появления.
 */
export const ERROR_RETENTION_DAYS = 90;

/**
 * Суммы запросов поминутно — две недели: на них точное сравнение «час до
 * и час после выкатки», и выкатку сравнивают в первые дни, пока она свежая.
 * Поминутных строк много (маршрут × минута с запросами), держать их дольше
 * незачем — для старых выкаток есть почасовые.
 */
export const MINUTE_RETENTION_DAYS = 14;

/**
 * Суммы запросов почасово — полгода: два-три цикла выкаток с запасом,
 * «как было весной» и сравнение версий, выкаченных месяцы назад. Строк —
 * не больше 24 × число маршрутов в день.
 */
export const HOUR_RETENTION_DAYS = 180;

/** Такт записи в базу: раз в десять секунд — строк за такт от единиц до сотен */
export const FLUSH_MS = 10_000;

/** Очередь строк лога, пока база недоступна: примерно час обычной работы */
export const PENDING_LOG_CAP = 20_000;
/** Минутных сумм в очереди: сотня маршрутов × три часа */
export const PENDING_AGG_CAP = 20_000;
/** Отпечатков ошибок в очереди: больше — это уже не ошибки, а поломка всего */
export const PENDING_ERROR_CAP = 1_000;

/*
 * Разбивка SQL сохраняется со строкой «request» только у запросов, которые
 * потом разбирают: медленных, упавших и тяжёлых по числу запросов к базе
 * (N+1). У остальных — число и время в полях строки, тексты — в памяти.
 */
export const HEAVY_SQL = 50;

const DAY = 86_400_000;

/* ─────────── версия выкатки ─────────── */

/**
 * Метка версии для сумм запросов: QUIZZY_VERSION и, если CI его задаёт,
 * QUIZZY_BUILD через «+» (как метаданные сборки в semver). Выкатка — это
 * смена метки в суммах; без переменной все запуски — одна «unversioned», и
 * сравнивать нечего (экран так и скажет).
 */
export function releaseTag(): string {
  const clean = (v: string | undefined) => v?.trim().replace(/[^\w.:-]/g, "").slice(0, 48) || "";
  const version = clean(process.env.QUIZZY_VERSION);
  const build = clean(process.env.QUIZZY_BUILD);
  if (!version) return build ? `unversioned+${build}` : "unversioned";
  return build ? `${version}+${build}` : version;
}

/* ─────────── очередь ─────────── */

interface LogRow {
  instance: string;
  seq: number;
  at: string;
  level: string;
  message: string;
  request_id: string | null;
  fingerprint: string | null;
  fields: Record<string, unknown>;
  sql: unknown;
  version: string;
}

/** Сумма запросов за минуту по маршруту и версии */
export interface AggRow {
  minute: number;
  version: string;
  method: string;
  route: string;
  count: number;
  c4: number;
  c5: number;
  sum: number;
  max: number;
  hist: number[];
}

interface PendingError {
  g: Omit<OpsErrorOccurrence, "at" | "lastRequestId">;
  count: number;
  firstAt: string;
  lastAt: string;
  lastRequestId: string | null;
  version: string;
  hours: Map<number, number>;
}

let pendingLogs: LogRow[] = [];
let pendingAggs = new Map<string, AggRow>();
let pendingErrors = new Map<string, PendingError>();

const state = {
  running: false,
  lastFlushAt: null as number | null,
  lastError: null as string | null,
  lastErrorAt: null as number | null,
  failures: 0,
  droppedLogs: 0,
  droppedAggs: 0,
  droppedErrors: 0,
};

/*
 * Корзины времени — те же, что у буфера и Prometheus (LATENCY_BUCKETS), и
 * та же раскладка «последняя — всё, что выше». Своя копия трёх строк
 * сложения, а не импорт из буфера: там это внутренность модуля, и
 * выставлять её наружу ради очереди — значит связать два модуля крепче,
 * чем они того стоят.
 */
function bucketOf(ms: number): number {
  const i = LATENCY_BUCKETS.findIndex((b) => ms <= b);
  return i === -1 ? LATENCY_BUCKETS.length : i;
}

function emptyAgg(minute: number, version: string, method: string, route: string): AggRow {
  return {
    minute,
    version,
    method,
    route,
    count: 0,
    c4: 0,
    c5: 0,
    sum: 0,
    max: 0,
    hist: new Array(LATENCY_BUCKETS.length + 1).fill(0),
  };
}

function addAgg(into: AggRow, from: AggRow): void {
  into.count += from.count;
  into.c4 += from.c4;
  into.c5 += from.c5;
  into.sum += from.sum;
  if (from.max > into.max) into.max = from.max;
  for (let i = 0; i < into.hist.length; i++) into.hist[i]! += from.hist[i] ?? 0;
}

const aggKey = (a: Pick<AggRow, "minute" | "version" | "method" | "route">) =>
  `${a.minute}|${a.version}|${a.method}|${a.route}`;

function queueLog(line: OpsLogLine): void {
  let sqlDetail: unknown = null;
  if (line.message === "request" && line.requestId) {
    const s = requestSql(line.requestId);
    const status = Number(line.fields.status ?? 0);
    const ms = Number(line.fields.ms ?? 0);
    if (s && (ms >= SLOW_MS || status >= 500 || s.count >= HEAVY_SQL)) {
      sqlDetail = { ...s, top: s.top.map((t) => ({ ...t, query: normalizeSql(t.query, 500) })) };
    }
  }
  pendingLogs.push({
    instance: line.instance ?? "",
    seq: line.seq,
    at: line.at,
    level: line.level,
    message: line.message,
    request_id: line.requestId,
    fingerprint: line.fingerprint ?? null,
    fields: line.fields,
    sql: sqlDetail,
    version: releaseTag(),
  });
  if (pendingLogs.length > PENDING_LOG_CAP) {
    const over = pendingLogs.length - PENDING_LOG_CAP;
    pendingLogs.splice(0, over);
    state.droppedLogs += over;
  }
}

function queueRequest(s: RequestSample & { at: number }): void {
  const key = { minute: Math.floor(s.at / 60_000), version: releaseTag(), method: s.method, route: s.route };
  const k = aggKey(key);
  let a = pendingAggs.get(k);
  if (!a) {
    if (pendingAggs.size >= PENDING_AGG_CAP) {
      state.droppedAggs++;
      return;
    }
    a = emptyAgg(key.minute, key.version, key.method, key.route);
    pendingAggs.set(k, a);
  }
  a.count++;
  if (s.code >= 500) a.c5++;
  else if (s.code >= 400) a.c4++;
  a.sum += s.ms;
  if (s.ms > a.max) a.max = s.ms;
  a.hist[bucketOf(s.ms)]!++;
}

function queueError(o: OpsErrorOccurrence): void {
  const hour = Math.floor(Date.parse(o.at) / 3_600_000) * 3_600_000;
  let p = pendingErrors.get(o.fingerprint);
  if (!p) {
    if (pendingErrors.size >= PENDING_ERROR_CAP) {
      state.droppedErrors++;
      return;
    }
    const { at: _at, lastRequestId: _rid, ...g } = o;
    p = { g, count: 0, firstAt: o.at, lastAt: o.at, lastRequestId: null, version: releaseTag(), hours: new Map() };
    pendingErrors.set(o.fingerprint, p);
  }
  p.count++;
  if (o.at < p.firstAt) p.firstAt = o.at;
  if (o.at >= p.lastAt) {
    p.lastAt = o.at;
    p.lastRequestId = o.lastRequestId ?? p.lastRequestId;
  }
  if (!p.g.frames.length && o.frames.length) p.g.frames = o.frames;
  p.hours.set(hour, (p.hours.get(hour) ?? 0) + 1);
}

/** Очистить очередь — «перезапуск процесса» в тестах (opsBuffer.resetOpsBuffers) */
export function resetOpsStore(): void {
  pendingLogs = [];
  pendingAggs = new Map();
  pendingErrors = new Map();
  state.lastFlushAt = null;
  state.lastError = null;
  state.lastErrorAt = null;
  state.failures = 0;
  state.droppedLogs = 0;
  state.droppedAggs = 0;
  state.droppedErrors = 0;
}

setOpsSink({ log: queueLog, request: queueRequest, error: queueError, reset: resetOpsStore });

/* ─────────── что ещё не записано — для чтения истории ─────────── */

/** Суммы запросов, ещё не ушедшие в базу: сравнение выкаток видит и последние секунды */
export function pendingAggRows(): AggRow[] {
  return [...pendingAggs.values()].map((a) => ({ ...a, hist: a.hist.slice() }));
}

/**
 * Строки лога, ещё не ушедшие в базу, — только момент и уровень: объёму лога
 * по уровням (lib/opsHistory.ts, readLogVolume) нужны последние секунды до
 * такта записи, а текст строк ему ни к чему.
 */
export function pendingLogStamps(): { at: string; level: string }[] {
  return pendingLogs.map((l) => ({ at: l.at, level: l.level }));
}

/** Приращения групп ошибок, ещё не ушедшие в базу */
export function pendingErrorGroups(): (OpsErrorGroup & { hours: [number, number][] })[] {
  return [...pendingErrors.values()].map((p) => ({
    ...p.g,
    frames: p.g.frames.slice(),
    count: p.count,
    firstAt: p.firstAt,
    lastAt: p.lastAt,
    lastRequestId: p.lastRequestId,
    hours: [...p.hours.entries()],
  }));
}

export function storeState(): OpsStoreState {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  return {
    running: state.running,
    lastFlushAt: iso(state.lastFlushAt),
    lastError: state.lastError,
    lastErrorAt: iso(state.lastErrorAt),
    pendingLogs: pendingLogs.length,
    droppedLogs: state.droppedLogs,
  };
}

/* ─────────── запись ─────────── */

/** Ошибка данных: значение не легло в колонку — повтор ничего не изменит */
function isDataError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^(22|23)/.test(code);
}

/** Одна пачка — в своей системной транзакции; политики строк пускают писать только систему */
const asSystemTx = <T>(fn: () => Promise<T>) => systemContext(baseDb, fn);

/*
 * Пачка уходит одним параметром jsonb. Знак NUL (\u0000) jsonb не принимает
 * вовсе, а в строку лога он попадает легко — из чужого заголовка, из
 * бинарного ответа в тексте ошибки. Одна такая строка валила бы всю пачку
 * ошибкой данных, поэтому он вычищается здесь, на входе в базу.
 */
const toJson = (rows: unknown) =>
  JSON.stringify(rows, (_k, v: unknown) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v));

const LOG_CHUNK = 1000;

async function writeLogs(rows: LogRow[]): Promise<void> {
  await asSystemTx(() =>
    db.execute(sql`
      insert into ops_log_lines (instance, seq, at, level, message, request_id, fingerprint, fields, sql, version)
      select r.instance, r.seq, r.at, r.level, r.message, r.request_id, r.fingerprint,
             coalesce(r.fields, '{}'::jsonb), r.sql, r.version
      from jsonb_to_recordset(${toJson(rows)}::jsonb) as r(
        instance text, seq bigint, at timestamptz, level text, message text,
        request_id text, fingerprint text, fields jsonb, sql jsonb, version text
      )
      on conflict (instance, seq) do nothing
    `),
  );
}

/**
 * Минутные строки как есть и часовые — их суммой. Часовые копятся
 * прибавлением: за час приходит шесть сотен пачек, каждая добавляет свою
 * долю в одну и ту же строку часа.
 */
export function aggUpsertRows(aggs: readonly AggRow[]) {
  const hours = new Map<string, AggRow>();
  for (const a of aggs) {
    const hourMinute = Math.floor(a.minute / 60) * 60;
    const k = aggKey({ ...a, minute: hourMinute });
    let h = hours.get(k);
    if (!h) {
      h = emptyAgg(hourMinute, a.version, a.method, a.route);
      hours.set(k, h);
    }
    addAgg(h, a);
  }
  const row = (grain: "minute" | "hour", a: AggRow) => ({
    grain,
    bucket: new Date(a.minute * 60_000).toISOString(),
    version: a.version,
    method: a.method,
    route: a.route,
    count: a.count,
    c4: a.c4,
    c5: a.c5,
    sum_ms: a.sum,
    max_ms: a.max,
    hist: a.hist,
  });
  return [...aggs.map((a) => row("minute", a)), ...[...hours.values()].map((h) => row("hour", h))];
}

async function writeAggs(aggs: AggRow[]): Promise<void> {
  const rows = aggUpsertRows(aggs);
  await asSystemTx(() =>
    db.execute(sql`
      insert into ops_request_aggs (grain, bucket, version, method, route, count, c4, c5, sum_ms, max_ms, hist)
      select r.grain, r.bucket, r.version, r.method, r.route, r.count, r.c4, r.c5, r.sum_ms, r.max_ms,
             array(select e.v::int from jsonb_array_elements_text(r.hist) with ordinality as e(v, i) order by e.i)
      from jsonb_to_recordset(${toJson(rows)}::jsonb) as r(
        grain text, bucket timestamptz, version text, method text, route text,
        count int, c4 int, c5 int, sum_ms float8, max_ms float8, hist jsonb
      )
      on conflict (grain, bucket, version, method, route) do update set
        count = ops_request_aggs.count + excluded.count,
        c4 = ops_request_aggs.c4 + excluded.c4,
        c5 = ops_request_aggs.c5 + excluded.c5,
        sum_ms = ops_request_aggs.sum_ms + excluded.sum_ms,
        max_ms = greatest(ops_request_aggs.max_ms, excluded.max_ms),
        hist = array(
          select coalesce(u.a, 0) + coalesce(u.b, 0)
          from unnest(ops_request_aggs.hist, excluded.hist) with ordinality as u(a, b, i)
          order by u.i
        )
    `),
  );
}

async function writeErrors(errors: PendingError[]): Promise<void> {
  const groups = errors.map((p) => ({
    fingerprint: p.g.fingerprint,
    origin: p.g.origin,
    name: p.g.name,
    message: p.g.message,
    method: p.g.method,
    route: p.g.route,
    code: p.g.code,
    count: p.count,
    first_at: p.firstAt,
    last_at: p.lastAt,
    last_request_id: p.lastRequestId,
    frames: p.g.frames,
    version: p.version,
  }));
  const hours = errors.flatMap((p) =>
    [...p.hours.entries()].map(([hour, count]) => ({ fingerprint: p.g.fingerprint, hour: new Date(hour).toISOString(), count })),
  );
  /*
   * Группа и её часы — одной транзакцией: часы ссылаются на группу, а
   * прибавление к счётчику при повторе пачки не должно случиться дважды.
   */
  await asSystemTx(async () => {
    await db.execute(sql`
      insert into ops_error_groups (fingerprint, origin, name, message, method, route, code, count,
                                    first_at, last_at, last_request_id, frames, first_version, last_version)
      select r.fingerprint, r.origin, r.name, r.message, r.method, r.route, r.code, r.count,
             r.first_at, r.last_at, r.last_request_id, coalesce(r.frames, '[]'::jsonb), r.version, r.version
      from jsonb_to_recordset(${toJson(groups)}::jsonb) as r(
        fingerprint text, origin text, name text, message text, method text, route text, code int,
        count bigint, first_at timestamptz, last_at timestamptz, last_request_id text, frames jsonb, version text
      )
      on conflict (fingerprint) do update set
        count = ops_error_groups.count + excluded.count,
        first_at = least(ops_error_groups.first_at, excluded.first_at),
        last_at = greatest(ops_error_groups.last_at, excluded.last_at),
        last_request_id = case when excluded.last_at >= ops_error_groups.last_at
                               then coalesce(excluded.last_request_id, ops_error_groups.last_request_id)
                               else ops_error_groups.last_request_id end,
        last_version = case when excluded.last_at >= ops_error_groups.last_at
                            then excluded.last_version else ops_error_groups.last_version end,
        code = coalesce(excluded.code, ops_error_groups.code),
        frames = case when jsonb_array_length(ops_error_groups.frames) = 0
                      then excluded.frames else ops_error_groups.frames end
    `);
    await db.execute(sql`
      insert into ops_error_hours (fingerprint, hour, count)
      select r.fingerprint, r.hour, r.count
      from jsonb_to_recordset(${toJson(hours)}::jsonb) as r(fingerprint text, hour timestamptz, count int)
      on conflict (fingerprint, hour) do update set count = ops_error_hours.count + excluded.count
    `);
  });
}

/** Вернуть несостоявшуюся пачку сумм в очередь — сложением с тем, что пришло за время попытки */
function requeueAggs(aggs: AggRow[]): void {
  for (const a of aggs) {
    const k = aggKey(a);
    const known = pendingAggs.get(k);
    if (known) addAgg(known, a);
    else if (pendingAggs.size < PENDING_AGG_CAP) pendingAggs.set(k, a);
    else state.droppedAggs++;
  }
}

function requeueErrors(errors: PendingError[]): void {
  for (const p of errors) {
    const known = pendingErrors.get(p.g.fingerprint);
    if (!known) {
      pendingErrors.set(p.g.fingerprint, p);
      continue;
    }
    known.count += p.count;
    if (p.firstAt < known.firstAt) known.firstAt = p.firstAt;
    if (p.lastAt > known.lastAt) {
      known.lastAt = p.lastAt;
      known.lastRequestId = p.lastRequestId ?? known.lastRequestId;
    }
    for (const [h, n] of p.hours) known.hours.set(h, (known.hours.get(h) ?? 0) + n);
  }
}

export interface FlushResult {
  logs: number;
  aggs: number;
  errors: number;
  /** Текст первого отказа, из-за которого пачка вернулась в очередь; null — всё записано */
  error: string | null;
}

let flushing: Promise<FlushResult> | null = null;

/**
 * Записать очередь в базу. Два такта не накладываются: второй получает
 * обещание первого. Не бросает никогда — результат говорит, что вышло.
 */
export function flushOpsStore(): Promise<FlushResult> {
  if (!flushing) flushing = doFlush().finally(() => (flushing = null));
  return flushing;
}

async function doFlush(): Promise<FlushResult> {
  const out: FlushResult = { logs: 0, aggs: 0, errors: 0, error: null };
  const fail = (what: string, error: unknown) => {
    const text = normalizeMessage(error instanceof Error ? error.message : String(error));
    out.error ??= `${what}: ${text}`;
    return text;
  };

  /*
   * Строки лога: повтор безвреден (ON CONFLICT DO NOTHING), поэтому
   * кусками — упавший кусок и хвост за ним возвращаются в очередь.
   *
   * Ошибка данных сидит в какой-то одной строке, а не во всей пачке: тогда
   * кусок уходит по строке, и отбрасывается только та, что не легла.
   * Случай редкий, и тысяча вставок по одной на нём дешевле тысячи
   * потерянных строк. Отказ другого рода посреди этого — как отказ куска:
   * остаток возвращается в очередь.
   */
  const logs = pendingLogs;
  pendingLogs = [];
  const requeueFrom = (rest: LogRow[]) => {
    pendingLogs = [...rest, ...pendingLogs];
    if (pendingLogs.length > PENDING_LOG_CAP) {
      const over = pendingLogs.length - PENDING_LOG_CAP;
      pendingLogs.splice(0, over);
      state.droppedLogs += over;
    }
  };
  chunks: for (let i = 0; i < logs.length; i += LOG_CHUNK) {
    const chunk = logs.slice(i, i + LOG_CHUNK);
    try {
      await writeLogs(chunk);
      out.logs += chunk.length;
      continue;
    } catch (error) {
      if (!isDataError(error)) {
        fail("logs", error);
        requeueFrom(logs.slice(i));
        break;
      }
      fail("logs", error);
    }
    let bad = 0;
    for (let j = 0; j < chunk.length; j++) {
      try {
        await writeLogs([chunk[j]!]);
        out.logs++;
      } catch (rowError) {
        if (isDataError(rowError)) {
          bad++;
          continue;
        }
        fail("logs", rowError);
        requeueFrom([...chunk.slice(j), ...logs.slice(i + LOG_CHUNK)]);
        state.droppedLogs += bad;
        break chunks;
      }
    }
    state.droppedLogs += bad;
    log.warn("ops.store.dropped", { kind: "logs", rows: bad });
  }

  const aggs = [...pendingAggs.values()];
  pendingAggs = new Map();
  if (aggs.length) {
    try {
      await writeAggs(aggs);
      out.aggs = aggs.length;
    } catch (error) {
      if (isDataError(error)) {
        state.droppedAggs += aggs.length;
        log.warn("ops.store.dropped", { kind: "aggs", rows: aggs.length, error: fail("aggs", error) });
      } else {
        fail("aggs", error);
        requeueAggs(aggs);
      }
    }
  }

  const errors = [...pendingErrors.values()];
  pendingErrors = new Map();
  if (errors.length) {
    try {
      await writeErrors(errors);
      out.errors = errors.length;
    } catch (error) {
      if (isDataError(error)) {
        state.droppedErrors += errors.length;
        log.warn("ops.store.dropped", { kind: "errors", rows: errors.length, error: fail("errors", error) });
      } else {
        fail("errors", error);
        requeueErrors(errors);
      }
    }
  }

  const now = Date.now();
  if (out.error) {
    state.failures++;
    state.lastError = out.error;
    state.lastErrorAt = now;
    /*
     * Предупреждение — в начале серии отказов и дальше раз в час тактов, а
     * не на каждый такт: при лежащей базе лог иначе заполнился бы одной и
     * той же строкой, а строка эта сама встала бы в очередь.
     */
    if (state.failures === 1 || state.failures % 360 === 0) {
      log.warn("ops.store.flush_failed", { failures: state.failures, pending: pendingLogs.length, error: out.error });
    }
  } else {
    if (state.failures > 0) log.info("ops.store.recovered", { failures: state.failures });
    state.failures = 0;
    state.lastFlushAt = now;
  }
  return out;
}

let flushTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Завести запись истории. Зовётся при запуске процесса API (index.ts) —
 * вне любого запроса: таймер, заведённый внутри запроса, унёс бы с собой
 * его хранилище (номер запроса и транзакцию) во все свои такты.
 *
 * Возвращает остановку: она дописывает очередь последним тактом, но не
 * дольше трёх секунд — выключение не должно зависать на лежащей базе.
 */
export function startOpsStore(intervalMs = FLUSH_MS): () => Promise<void> {
  state.running = true;
  registerJob("ops.flush", intervalMs);
  const tick = () =>
    trackJob("ops.flush", async () => {
      const r = await flushOpsStore();
      /* отказ — в реестр задач: «запись истории вообще идёт?» видно на вкладке задач */
      if (r.error) throw new Error(r.error);
      return r;
    }).catch(() => {
      // уже в state и в реестре задач
    });
  flushTimer = setInterval(tick, intervalMs);
  (flushTimer as { unref?: () => void }).unref?.();
  return async () => {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    state.running = false;
    await Promise.race([flushOpsStore(), new Promise((r) => setTimeout(r, 3000))]);
  };
}

/* ─────────── ротация ─────────── */

const ROTATE_BATCH = 5000;

export interface RotateResult {
  logs: number;
  errorGroups: number;
  errorHours: number;
  minuteAggs: number;
  hourAggs: number;
}

/**
 * Удалить то, что старше срока. Порциями, каждая в своей транзакции — тот
 * же приём, что у ретенции потока событий (lib/retention.ts): одна большая
 * DELETE держала бы блокировку и раздувала WAL, а автоочистка не могла бы
 * убрать ни одной версии до конца прохода.
 */
export async function rotateOpsStore(now = Date.now()): Promise<RotateResult> {
  const before = (days: number) => new Date(now - days * DAY).toISOString();
  const drain = async (query: (cutoff: string) => ReturnType<typeof sql>, cutoff: string) => {
    let total = 0;
    for (;;) {
      const n = await asSystemTx(async () => (await db.execute(query(cutoff))).length);
      total += n;
      if (n < ROTATE_BATCH) return total;
    }
  };
  const out: RotateResult = {
    logs: await drain(
      (c) => sql`delete from ops_log_lines where ctid in (
        select ctid from ops_log_lines where at < ${c} limit ${ROTATE_BATCH}) returning 1`,
      before(LOG_RETENTION_DAYS),
    ),
    errorHours: await drain(
      (c) => sql`delete from ops_error_hours where ctid in (
        select ctid from ops_error_hours where hour < ${c} limit ${ROTATE_BATCH}) returning 1`,
      before(ERROR_RETENTION_DAYS),
    ),
    /* группа уходит, когда не повторялась весь срок; её часы уйдут каскадом, если ещё остались */
    errorGroups: await drain(
      (c) => sql`delete from ops_error_groups where fingerprint in (
        select fingerprint from ops_error_groups where last_at < ${c} limit ${ROTATE_BATCH}) returning 1`,
      before(ERROR_RETENTION_DAYS),
    ),
    minuteAggs: await drain(
      (c) => sql`delete from ops_request_aggs where ctid in (
        select ctid from ops_request_aggs where grain = 'minute' and bucket < ${c} limit ${ROTATE_BATCH}) returning 1`,
      before(MINUTE_RETENTION_DAYS),
    ),
    hourAggs: await drain(
      (c) => sql`delete from ops_request_aggs where ctid in (
        select ctid from ops_request_aggs where grain = 'hour' and bucket < ${c} limit ${ROTATE_BATCH}) returning 1`,
      before(HOUR_RETENTION_DAYS),
    ),
  };
  if (Object.values(out).some((n) => n > 0)) log.info("ops.rotate", { ...out });
  return out;
}

/**
 * Такт ротации — раз в шесть часов: сроки меряются днями, и лишние шесть
 * часов строки ничего не стоят, а частый проход по индексу времени — стоит.
 * Только там, где включён планировщик: ротация общая на все реплики.
 */
export function startOpsRotation(intervalMs = 6 * 3_600_000): () => void {
  registerJob("ops.rotate", intervalMs);
  const tick = () => {
    trackJob("ops.rotate", () => rotateOpsStore()).catch((error) =>
      log.error("ops.rotate_failed", { error: String(error) }),
    );
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return () => clearInterval(timer);
}
