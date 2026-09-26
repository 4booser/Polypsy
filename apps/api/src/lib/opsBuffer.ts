/**
 * Короткая память процесса для техпанели: логи, запросы, ошибки.
 *
 * Решение заказчика 2026-09-26: «дашборд для разработчиков — логи, ошибки,
 * нагрузка, количество запросов и время ответа». Логи уходят в stdout, метрики
 * — в Prometheus, ошибки — в GlitchTip; но всё это живёт снаружи, и на
 * маленькой установке без сборщиков разработчику смотреть было некуда, кроме
 * `docker logs`. Здесь — последние минуты и часы того же самого, прямо в
 * консоли.
 *
 * Кольцевые буферы в памяти, а не таблица. Таблица логов — это ещё один
 * склад, у которого свой режим доступа, свой срок хранения и своё место в
 * бэкапе; и каждая строка запроса превращалась бы в запись в базу, то есть
 * наблюдение само становилось бы нагрузкой, которую наблюдает. Цена названа
 * вслух: буферы живут до перезапуска процесса и видят только свой процесс.
 * Экран обязан это говорить («з моменту запуску…»), поэтому каждый ответ
 * несёт `since`.
 *
 * Подключено в существующие точки, а не параллельной обвязкой: запись лога
 * (log.ts), промежуточный слой запроса (middleware/requestId.ts), обработчик
 * ошибок приложения (app.ts). Второй набор «наблюдателей» рядом с первым
 * разошёлся бы с ним: метрика считала бы одно, панель другое.
 *
 * Персональных данных здесь быть не должно по тому же правилу, что и в логе
 * (поля — маршрут, роль, длительность, код), — но буфер показывается на
 * экране человеку с правом ops.read, у которого НЕТ права видеть пациентов.
 * Поэтому поверх правила стоит пояс: поля с запрещёнными именами
 * заменяются, почта и телефоны в строках маскируются (scrub). Лог в stdout
 * этого не делает — его читает тот, кто и так держит сервер и базу.
 *
 * Решение заказчика 2026-09-26 (участок obs2a): поверх буферов — история в
 * базе, которая переживает перезапуск (lib/opsStore.ts). Возражение выше
 * при этом в силе и учтено, а не отменено: в базу идёт не строка на
 * запрос, а пачка раз в десять секунд из очереди в памяти, у таблиц свой
 * срок хранения и своя ротация, а в очередь попадает уже вычищенное здесь.
 * Буфер о базе не знает — хранилище вешает приёмник (setOpsSink) само;
 * буферы остались живым хвостом, и «з моменту запуску» теперь говорят
 * только вкладки, у которых истории нет.
 */
import type {
  OpsErrorGroup,
  OpsLevel,
  OpsLogLine,
  OpsRouteStat,
  OpsSlowRequest,
  OpsTrafficBucket,
  OpsWindow,
  OpsWindowStats,
  Role,
} from "@quizzy/shared";
import { LATENCY_BUCKETS } from "./metrics";

/**
 * Момент запуска процесса. Из uptime, а не из времени загрузки модуля:
 * модуль грузится позже старта, и на холодном процессе разница заметна.
 */
export const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString();

/**
 * Экземпляр процесса — для истории в базе (lib/opsStore.ts). Номер строки
 * лога сквозной только внутри процесса и после перезапуска начинается с
 * единицы; строки истории различаются парой «экземпляр + номер», и по ней
 * же живой хвост из памяти склеивается с историей без дублей.
 */
let instance = crypto.randomUUID().slice(0, 8);
export const instanceId = () => instance;

/* ─────────── постоянное хранение ─────────── */

/** Один случай ошибки — то, что пришло в группу, с моментом и номером запроса */
export type OpsErrorOccurrence = Omit<OpsErrorGroup, "count" | "firstAt" | "lastAt"> & { at: string };

/**
 * Куда ещё уходят записи буфера: история в базе (lib/opsStore.ts).
 *
 * Буфер о базе не знает — хранилище само вешает сюда приёмник при своей
 * загрузке. Так log.ts, который грузят и миграции, и сиды, и расшифровщик,
 * не тянет за собой пул соединений, а процесс без хранилища просто ничего
 * не копит. Отказ приёмника не должен стоить ни строки лога, ни ответа на
 * запрос — поэтому каждый вызов под защитой.
 */
export interface OpsSink {
  log(line: OpsLogLine): void;
  request(s: RequestSample & { at: number }): void;
  error(o: OpsErrorOccurrence): void;
  reset(): void;
}

let sink: OpsSink | null = null;

export function setOpsSink(next: OpsSink | null): void {
  sink = next;
}

function toSink(fn: (s: OpsSink) => void): void {
  if (!sink) return;
  try {
    fn(sink);
  } catch {
    // история — удобство; лог и ответ важнее
  }
}

/* ─────────── вычистка данных ─────────── */

/**
 * Имена полей, значение которых не показывается никогда.
 *
 * Надмножество списка сборщика ошибок (errorReport.FORBIDDEN; тест следит,
 * чтобы так и оставалось) плюс всё, что похоже на секрет. Сравнение без
 * учёта регистра: `Authorization` и `authorization` — одно поле.
 */
export const PERSONAL_KEYS: ReadonlySet<string> = new Set(
  [
    "body",
    "headers",
    "cookies",
    "cookie",
    "authorization",
    "email",
    "firstName",
    "lastName",
    "middleName",
    "fullName",
    "birthDate",
    "phone",
    "answers",
    "password",
    "passwordHash",
    "token",
    "accessToken",
    "refreshToken",
    "secret",
  ].map((k) => k.toLowerCase()),
);

const HIDDEN = "[hidden]";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/*
 * Телефоны — только украинского вида и международные с «+». Общее «много
 * цифр подряд» задело бы метки времени и идентификаторы, и лента
 * превратилась бы в «[phone]» через строку.
 */
const PHONE = /(?<![\w+])(?:\+?380|0)\d{9}(?!\d)|\+\d{10,14}(?!\d)/g;

/** Строка без почты и телефонов, обрезанная до разумной длины */
export function scrubText(s: string, max = 500): string {
  const out = s.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Значение поля лога в показываемом виде: без запрещённых полей, без почты и телефонов, неглубоко */
export function scrub(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return scrubText(`${value.name}: ${value.message}`);
  if (typeof value !== "object") return null;
  if (depth >= 3) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    out[k] = PERSONAL_KEYS.has(k.toLowerCase()) ? HIDDEN : scrub(v, depth + 1);
  }
  return out;
}

/**
 * Сообщение ошибки без данных — для показа и для отпечатка группы.
 *
 * Сообщения бывают двух пород. Одни говорят о коде: «Cannot read properties
 * of undefined (reading 'units')», «relation "x" does not exist» — имя
 * свойства и таблицы тут не данные, а ответ на вопрос «где». Другие несут
 * значение: «invalid input syntax for type uuid: "…"» — там то, что прислал
 * человек. Правила ниже стараются оставить первое и убрать второе:
 *
 *   — почта и телефоны маскируются всегда;
 *   — UUID → «:id» (одна и та же ошибка на разных людях — одна группа);
 *   — значение после двоеточия в кавычках → «?» (так Postgres цитирует ввод);
 *   — строка в одинарных кавычках остаётся, только если похожа на имя
 *     (буквы, цифры, подчёркивание), иначе → «?»;
 *   — числа от пяти знаков → «N»: идентификаторы, метки времени, счётчики.
 *
 * Правила не доказывают отсутствия данных, они уменьшают их вероятность. На
 * этом и держится вторая половина защиты: панель закрыта отдельным правом.
 */
export function normalizeMessage(raw: string): string {
  return scrubText(raw.replace(/\s+/g, " ").trim(), 300)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ":id")
    .replace(/:\s*"[^"]*"/g, ': "?"')
    .replace(/:\s*'[^']*'/g, ": '?'")
    .replace(/'([^']*)'/g, (_m, inner: string) => (/^[A-Za-z_$][\w$.]*$/.test(inner) ? `'${inner}'` : "'?'"))
    .replace(/(?<![\w.])\d{5,}(?![\w])/g, "N");
}

/* ─────────── логи ─────────── */

export const LOG_CAPACITY = 5000;
const LEVEL_RANK: Record<OpsLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

interface LogRec extends OpsLogLine {
  /** Строка для поиска — считается один раз при записи, а не на каждом опросе ленты */
  hay: string;
}

const logRing: (LogRec | undefined)[] = new Array(LOG_CAPACITY);
let logSeq = 0;

/**
 * Запись лога в буфер. Зовётся из log.ts ПОСЛЕ сверки с порогом LOG_LEVEL:
 * буфер показывает ровно то, что уходит в stdout, не больше.
 *
 * Строки о запросах самой панели в ленту не кладутся. Лента опрашивает
 * сервер раз в несколько секунд, и каждый опрос рождал бы новую строку —
 * лента никогда бы не замолкала и показывала бы в основном саму себя. В
 * счётчики запросов эти обращения при этом попадают: это настоящая нагрузка.
 */
export function captureLog(
  level: OpsLevel,
  message: string,
  fields: Record<string, unknown>,
  requestId: string | null,
): void {
  if (message === "request" && typeof fields.path === "string" && fields.path.startsWith("/api/ops")) return;
  const clean = (scrub(fields) ?? {}) as Record<string, unknown>;
  const text = scrubText(message, 200);
  const seq = ++logSeq;
  /*
   * Ошибка, записанная в лог мимо обработчика запросов, — тоже ошибка:
   * упавший проход расписания или рассылки иначе был бы виден только в
   * ленте, где его унесёт через пять тысяч строк. «unhandled» и строку
   * запроса с кодом 5xx пропускаем: их группу заводит onError, со стеком,
   * а отпечаток приходит в поле fingerprint (app.ts). Отпечаток у строки —
   * мостик для трассы запроса: «эта строка — вот эта группа».
   */
  let fingerprint: string | null = null;
  if (level === "error" && message !== "unhandled" && message !== "request") {
    fingerprint = recordLoggedError(text, fields, requestId);
  } else if (message === "unhandled" && typeof fields.fingerprint === "string") {
    fingerprint = fields.fingerprint;
  }
  const line: OpsLogLine = {
    seq,
    at: new Date().toISOString(),
    level,
    message: text,
    requestId,
    fields: clean,
    instance,
    fingerprint,
  };
  logRing[seq % LOG_CAPACITY] = { ...line, hay: `${text} ${JSON.stringify(clean)}`.toLowerCase() };
  toSink((k) => k.log(line));
}

export interface LogQuery {
  /** Минимальный уровень: warn показывает warn и error */
  level?: OpsLevel;
  q?: string;
  requestId?: string;
  after?: number;
  limit?: number;
}

/**
 * Выборка ленты.
 *
 * Идёт от новых к старым и останавливается на `limit` — дешевле, чем
 * фильтровать все пять тысяч и резать хвост. Отдаётся по возрастанию номера.
 * `cursor` — последний номер буфера целиком, а не последней совпавшей
 * строки: иначе при узком фильтре каждый опрос заново просматривал бы всё,
 * что не совпало в прошлый раз.
 */
export function readLogs(query: LogQuery) {
  const limit = Math.max(1, Math.min(1000, query.limit ?? 200));
  const minRank = LEVEL_RANK[query.level ?? "debug"];
  const oldest = Math.max(1, logSeq - LOG_CAPACITY + 1);
  const after = query.after ?? 0;
  const from = Math.max(oldest, after + 1);
  const needle = query.q?.trim().toLowerCase() || null;
  /* номер запроса можно вставить и укороченным — так его печатает лог разработки */
  const rid = query.requestId?.trim() || null;

  const found: OpsLogLine[] = [];
  let truncated = false;
  for (let s = logSeq; s >= from; s--) {
    const rec = logRing[s % LOG_CAPACITY];
    if (!rec || rec.seq !== s) continue;
    if (LEVEL_RANK[rec.level] < minRank) continue;
    if (rid && !(rec.requestId === rid || (rid.length >= 8 && rec.requestId?.startsWith(rid)))) continue;
    if (needle && !rec.hay.includes(needle)) continue;
    if (found.length >= limit) {
      truncated = true;
      break;
    }
    const { hay: _hay, ...line } = rec;
    found.push(line);
  }
  found.reverse();
  return {
    items: found,
    cursor: logSeq,
    oldestSeq: logSeq ? oldest : null,
    gap: after > 0 && after + 1 < oldest,
    truncated,
  };
}

/* ─────────── запросы ─────────── */

/** Сумма запросов за корзину: число, ошибки, время и распределение времени */
interface Agg {
  count: number;
  c4: number;
  c5: number;
  sum: number;
  max: number;
  /** Счётчики по корзинам LATENCY_BUCKETS; последняя — всё, что выше 5 с */
  hist: number[];
}

const emptyAgg = (): Agg => ({ count: 0, c4: 0, c5: 0, sum: 0, max: 0, hist: new Array(LATENCY_BUCKETS.length + 1).fill(0) });

function addTo(a: Agg, code: number, ms: number): void {
  a.count++;
  if (code >= 500) a.c5++;
  else if (code >= 400) a.c4++;
  a.sum += ms;
  if (ms > a.max) a.max = ms;
  const i = LATENCY_BUCKETS.findIndex((b) => ms <= b);
  a.hist[i === -1 ? LATENCY_BUCKETS.length : i]!++;
}

function mergeInto(a: Agg, b: Agg): void {
  a.count += b.count;
  a.c4 += b.c4;
  a.c5 += b.c5;
  a.sum += b.sum;
  if (b.max > a.max) a.max = b.max;
  for (let i = 0; i < a.hist.length; i++) a.hist[i]! += b.hist[i]!;
}

/**
 * Перцентиль по корзинам — тем же способом, что histogram_quantile в
 * Prometheus: находим корзину, где накопленная доля переходит q, и
 * интерполируем линейно внутри неё. Выше последней границы интерполировать
 * не к чему — отдаём наблюдённый максимум. И ни при каком раскладе
 * перцентиль не больше максимума: сто запросов по 30 мс дают p50 = 30, а
 * не 37,5 из середины корзины 25–50.
 */
export function quantile(hist: readonly number[], q: number, max: number, bounds: readonly number[] = LATENCY_BUCKETS): number | null {
  const total = hist.reduce((s, n) => s + n, 0);
  if (!total) return null;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i]!;
    if (!n) continue;
    if (cum + n >= rank) {
      if (i >= bounds.length) return Math.round(max);
      const lo = i === 0 ? 0 : bounds[i - 1]!;
      const hi = bounds[i]!;
      return Math.round(Math.min(lo + ((rank - cum) / n) * (hi - lo), max));
    }
    cum += n;
  }
  return Math.round(max);
}

function statsOf(a: Agg): OpsWindowStats {
  const has = a.count > 0;
  return {
    requests: a.count,
    errors4xx: a.c4,
    errors5xx: a.c5,
    share5xx: has ? a.c5 / a.count : null,
    avgMs: has ? Math.round(a.sum / a.count) : null,
    p50: quantile(a.hist, 0.5, a.max),
    p95: quantile(a.hist, 0.95, a.max),
    p99: quantile(a.hist, 0.99, a.max),
    maxMs: has ? Math.round(a.max) : null,
  };
}

/** Сутки поминутно: 1440 корзин по кругу, корзина помнит, какой минуты она */
const MINUTES = 1440;
const minuteRing: (Agg & { minute: number })[] = Array.from({ length: MINUTES }, () => ({ ...emptyAgg(), minute: -1 }));

function minuteSlot(minute: number): Agg & { minute: number } {
  const slot = minuteRing[minute % MINUTES]!;
  if (slot.minute !== minute) Object.assign(slot, emptyAgg(), { minute });
  return slot;
}

/** Корзина минуты, если она ещё про эту минуту; иначе — пусто */
function minuteAt(minute: number): Agg | null {
  const slot = minuteRing[minute % MINUTES]!;
  return slot.minute === minute ? slot : null;
}

/*
 * По маршруту — за всё время процесса. Ключ — шаблон маршрута (routePath),
 * поэтому число ключей ограничено числом маршрутов приложения, а не числом
 * пациентов: идентификаторы в ключ не попадают.
 */
const routeAggs = new Map<string, Agg & { method: string; route: string }>();

export const SLOW_MS = 1000;
export const SLOW_CAPACITY = 200;
const slowRing: OpsSlowRequest[] = [];

export interface RequestSample {
  method: string;
  route: string;
  code: number;
  ms: number;
  role: Role | null;
  requestId: string;
  /** Момент, мс; по умолчанию — сейчас. Параметром — ради тестов корзин */
  at?: number;
}

/** Зовётся промежуточным слоем запроса (middleware/requestId.ts) по завершении */
export function recordRequest(s: RequestSample): void {
  ensureLagSampler();
  const at = s.at ?? Date.now();
  addTo(minuteSlot(Math.floor(at / 60_000)), s.code, s.ms);
  toSink((k) => k.request({ ...s, at }));

  const key = `${s.method} ${s.route}`;
  let r = routeAggs.get(key);
  if (!r) {
    r = { ...emptyAgg(), method: s.method, route: s.route };
    routeAggs.set(key, r);
  }
  addTo(r, s.code, s.ms);

  if (s.ms >= SLOW_MS) {
    slowRing.unshift({
      at: new Date(at).toISOString(),
      method: s.method,
      route: s.route,
      code: s.code,
      ms: Math.round(s.ms),
      role: s.role,
      requestId: s.requestId,
    });
    if (slowRing.length > SLOW_CAPACITY) slowRing.length = SLOW_CAPACITY;
  }
}

/** Сводка за последние `minutes` минут, включая текущую неполную */
export function windowStats(minutes: number, now = Date.now()): OpsWindowStats {
  const nowMin = Math.floor(now / 60_000);
  const acc = emptyAgg();
  for (let m = nowMin - Math.min(minutes, MINUTES) + 1; m <= nowMin; m++) {
    const b = minuteAt(m);
    if (b) mergeInto(acc, b);
  }
  return statsOf(acc);
}

const WINDOW: Record<OpsWindow, { stepMin: number; spanMin: number }> = {
  /* минута — самое мелкое, что есть; час из шестидесяти столбцов ещё читается */
  "1h": { stepMin: 1, spanMin: 60 },
  "6h": { stepMin: 5, spanMin: 360 },
  /* сутки по 15 минут — 96 столбцов: мельче они сливаются в полосу */
  "24h": { stepMin: 15, spanMin: 1440 },
};

/**
 * Ряд корзин окна. Корзины выровнены по шагу («:00, :15, :30»), последняя —
 * текущая и неполная: ровная сетка времени читается легче, чем сетка,
 * отсчитанная от случайного «сейчас».
 */
export function trafficSeries(window: OpsWindow, now = Date.now()): { stepSec: number; buckets: OpsTrafficBucket[] } {
  const { stepMin, spanMin } = WINDOW[window];
  const nowMin = Math.floor(now / 60_000);
  const count = spanMin / stepMin;
  const lastStart = nowMin - (nowMin % stepMin);
  const firstStart = lastStart - (count - 1) * stepMin;
  const oldestKept = nowMin - MINUTES + 1;

  const buckets: OpsTrafficBucket[] = [];
  for (let i = 0; i < count; i++) {
    const start = firstStart + i * stepMin;
    const acc = emptyAgg();
    for (let m = Math.max(start, oldestKept); m < start + stepMin && m <= nowMin; m++) {
      const b = minuteAt(m);
      if (b) mergeInto(acc, b);
    }
    const s = statsOf(acc);
    buckets.push({
      at: new Date(start * 60_000).toISOString(),
      requests: s.requests,
      errors4xx: s.errors4xx,
      errors5xx: s.errors5xx,
      avgMs: s.avgMs,
      maxMs: s.maxMs,
      p50: s.p50,
      p95: s.p95,
      p99: s.p99,
    });
  }
  return { stepSec: stepMin * 60, buckets };
}

/** Маршруты за всё время процесса, самые частые первыми */
export function routeStats(): OpsRouteStat[] {
  return [...routeAggs.values()]
    .map((r) => ({ method: r.method, route: r.route, ...statsOf(r) }))
    .sort((a, b) => b.requests - a.requests || a.route.localeCompare(b.route));
}

/** Медленные запросы, новые первыми */
export function slowRequests(): OpsSlowRequest[] {
  return slowRing.slice();
}

/* ─────────── ошибки ─────────── */

export const ERROR_CAPACITY = 200;
const errorGroups = new Map<string, OpsErrorGroup>();
let droppedGroups = 0;

/**
 * Кадр стека без абсолютного пути: «apps/api/src/routes/x.ts:12:5».
 *
 * Путь до корня репозитория говорит о машине, а не об ошибке (на сервере
 * это /app, у разработчика — его домашний каталог), и одна ошибка на двух
 * машинах иначе давала бы две группы.
 */
export function shortenFrame(line: string): string {
  return line
    .trim()
    .replace(/file:\/\//g, "")
    .replace(/\/[^\s()]*?\/node_modules\//g, "node_modules/")
    .replace(/\/[^\s()]*?\/((?:apps|packages)\/)/g, "$1");
}

/** Кадры стека — только строки «at …»: заголовок с сообщением сюда не идёт */
export function framesOf(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, 15)
    .map(shortenFrame);
}

/** Кадр нашего кода — не библиотеки и не рантайма */
const isOwnFrame = (f: string) => /(?:apps|packages)\//.test(f) && !f.includes("node_modules/");

function fingerprintOf(parts: string[]): string {
  return new Bun.CryptoHasher("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 12);
}

function upsertGroup(g: OpsErrorOccurrence): void {
  toSink((k) => k.error(g));
  const known = errorGroups.get(g.fingerprint);
  if (known) {
    known.count++;
    known.lastAt = g.at;
    known.lastRequestId = g.lastRequestId ?? known.lastRequestId;
    known.code = g.code ?? known.code;
    /* свежие кадры — если прежние были пустыми (первой пришла запись из лога) */
    if (!known.frames.length && g.frames.length) known.frames = g.frames;
    return;
  }
  /*
   * Вместимость — двести групп. Сверх неё вытесняется та, что дольше всех не
   * повторялась: она, скорее всего, уже неактуальна, а свежая — ровно то,
   * ради чего смотрят. Сколько вытеснено — говорится на экране.
   */
  if (errorGroups.size >= ERROR_CAPACITY) {
    let stalest: OpsErrorGroup | null = null;
    for (const e of errorGroups.values()) if (!stalest || e.lastAt < stalest.lastAt) stalest = e;
    if (stalest) errorGroups.delete(stalest.fingerprint);
    droppedGroups++;
  }
  const { at, ...rest } = g;
  errorGroups.set(g.fingerprint, { ...rest, count: 1, firstAt: at, lastAt: at });
}

/**
 * Необработанное исключение запроса — из app.onError, рядом с отправкой в
 * сборщик ошибок. Отпечаток: тип + сообщение без данных + верхний кадр
 * нашего кода (без колонки) + маршрут шаблоном. Колонка отброшена: правка
 * соседнего выражения в той же строке не делает ошибку другой.
 */
export function recordError(input: {
  error: unknown;
  method: string | null;
  route: string | null;
  code?: number | null;
  requestId?: string | null;
  at?: number;
}): string {
  const err = input.error instanceof Error ? input.error : new Error(String(input.error));
  const message = normalizeMessage(err.message || "");
  const frames = framesOf(err.stack);
  const top = frames.find(isOwnFrame)?.replace(/:\d+\)?$/, "") ?? "";
  const fingerprint = fingerprintOf(["request", err.name, message, top, `${input.method ?? ""} ${input.route ?? ""}`]);
  upsertGroup({
    fingerprint,
    origin: "request",
    name: err.name || "Error",
    message,
    method: input.method,
    route: input.route,
    code: input.code ?? 500,
    lastRequestId: input.requestId ?? null,
    frames,
    at: new Date(input.at ?? Date.now()).toISOString(),
  });
  return fingerprint;
}

/** log.error вне обработчика запроса: упавший проход, отказ журнала, сбой отправки */
function recordLoggedError(message: string, fields: Record<string, unknown>, requestId: string | null): string {
  const raw = fields.error;
  const detail = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : "";
  const text = normalizeMessage(detail);
  const fingerprint = fingerprintOf(["log", message, text]);
  upsertGroup({
    fingerprint,
    origin: "log",
    name: message,
    message: text,
    method: null,
    route: null,
    code: null,
    lastRequestId: requestId,
    frames: raw instanceof Error ? framesOf(raw.stack) : [],
    at: new Date().toISOString(),
  });
  return fingerprint;
}

/** Группы ошибок, последние первыми */
export function errorGroupList(): { items: OpsErrorGroup[]; dropped: number } {
  const items = [...errorGroups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  return { items: items.map((g) => ({ ...g, frames: g.frames.slice() })), dropped: droppedGroups };
}

/* ─────────── задержка цикла событий ─────────── */

/*
 * Свой замер, а не perf_hooks.monitorEventLoopDelay: таймер раз в полсекунды
 * и опоздание его срабатывания против ожидаемого. Этого хватает на вопрос
 * «не держит ли что-то процесс» — а у встроенного счётчика в Bun своя
 * семантика единиц, которую пришлось бы помнить и проверять.
 *
 * Запускается при первом запросе, а не при загрузке модуля: log.ts грузят и
 * расшифровщик, и миграции, и сиды — им таймер ни к чему. unref — чтобы он
 * не держал процесс живым после остального.
 */
const LAG_TICK_MS = 500;
const LAG_SAMPLES = 120;
const lagSamples: number[] = [];
let lagTimer: ReturnType<typeof setInterval> | null = null;

export function ensureLagSampler(): void {
  if (lagTimer) return;
  let expected = performance.now() + LAG_TICK_MS;
  lagTimer = setInterval(() => {
    const now = performance.now();
    lagSamples.push(Math.max(0, now - expected));
    if (lagSamples.length > LAG_SAMPLES) lagSamples.shift();
    expected = now + LAG_TICK_MS;
  }, LAG_TICK_MS);
  (lagTimer as { unref?: () => void }).unref?.();
}

/** Средняя и наибольшая задержка за последнюю минуту; null — замеров ещё нет */
export function eventLoopLag(): { mean: number | null; max: number | null } {
  if (lagSamples.length < 2) return { mean: null, max: null };
  const sum = lagSamples.reduce((s, v) => s + v, 0);
  return {
    mean: Math.round((sum / lagSamples.length) * 10) / 10,
    max: Math.round(Math.max(...lagSamples) * 10) / 10,
  };
}

/**
 * Только для тестов: буферы общие на процесс, и проверки не должны видеть
 * чужое. Сброс — это «перезапуск процесса»: номер экземпляра новый, и
 * очередь записи истории (если хранилище подключено) пуста.
 */
export function resetOpsBuffers(): void {
  instance = crypto.randomUUID().slice(0, 8);
  toSink((k) => k.reset());
  logRing.fill(undefined);
  logSeq = 0;
  for (const slot of minuteRing) Object.assign(slot, emptyAgg(), { minute: -1 });
  routeAggs.clear();
  slowRing.length = 0;
  errorGroups.clear();
  droppedGroups = 0;
}
