/**
 * Телеметрия клиента на сервере: ошибки консоли и мобилки, скорость экранов.
 *
 * Решение заказчика 2026-09-26: техпанели нужны падения экранов, сетевые
 * сбои и Web Vitals консоли. Приходит это из браузера и телефона человека,
 * работающего с клиническими данными, поэтому вход устроен как таможня, а
 * не как приёмная:
 *
 *   — лишнее поле — отказ всего запроса (схема strict): клиент, приславший
 *     `email` или `body`, сломан или чужой, и склеивать за него нельзя;
 *   — адрес не шаблоном (`/patients/7c9e…` вместо `/patients/:id`) — отказ
 *     этой строки, и она не хранится вовсе;
 *   — сообщение и стек чистятся ещё раз, тем же фильтром, что серверные
 *     ошибки техпанели (normalizeMessage из opsBuffer.ts), поверх клиентской
 *     чистки (maskText из @quizzy/shared);
 *   — частота ограничена: без входа — жёстко и по адресу, со входом — по
 *     учётке; и общий потолок на всех — сломанная сборка консоли у ста
 *     человек не должна становиться нагрузкой на базу.
 */
import { count, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  COARSE_NAME,
  RUM_SAMPLE_RATE,
  VITAL_BOUNDS,
  VITAL_MAX,
  VITAL_METRICS,
  cleanFrames,
  histQuantile,
  isClientRoute,
  maskText,
  vitalBucket,
  vitalRating,
  type ClientErrorInput,
  type OpsClientErrorGroup,
  type OpsClientErrors,
  type OpsVitalCell,
  type OpsVitals,
  type VitalInput,
  type VitalMetric,
  type VitalRating,
} from "@quizzy/shared";
import { db } from "../db";
import { opsClientErrors, opsVitals } from "../db/schema";
import { dayOf } from "./day";
import { HISTORY_DAYS } from "./opsAlerts";
import { normalizeMessage } from "./opsBuffer";

/* ─────────── ограничение частоты ─────────── */

/**
 * Окно фиксированной длины на ключ: «не больше N штук за десять минут».
 *
 * В памяти процесса: две реплики дадут вдвое больше — для телеметрии это
 * приемлемо, а общий счётчик в базе сделал бы каждую присланную ошибку
 * записью в базу ещё до проверки, то есть превратил бы защиту в нагрузку.
 */
export class WindowLimiter {
  private used = new Map<string, { start: number; n: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Взять n штук; false — окно исчерпано, ничего не взято */
  take(key: string, n: number, now = Date.now()): boolean {
    let slot = this.used.get(key);
    if (!slot || now - slot.start >= this.windowMs) {
      slot = { start: now, n: 0 };
      this.used.set(key, slot);
    }
    if (slot.n + n > this.limit) return false;
    slot.n += n;
    if (this.used.size > 5000) {
      for (const [k, v] of this.used) if (now - v.start >= this.windowMs) this.used.delete(k);
    }
    return true;
  }

  /** Сколько секунд до конца окна ключа — для Retry-After */
  retryAfterSec(key: string, now = Date.now()): number {
    const slot = this.used.get(key);
    return slot ? Math.max(1, Math.ceil((slot.start + this.windowMs - now) / 1000)) : 1;
  }

  reset(): void {
    this.used.clear();
  }
}

const TEN_MIN = 10 * 60_000;

/**
 * Пределы. Без входа — пять ошибок в пачке и десять за десять минут с
 * одного адреса: экрану входа больше не нужно, а открытый приём без
 * потолка — это способ писать в нашу базу кому угодно. Со входом — двадцать
 * в пачке и сто двадцать за десять минут на учётку. На всех — три тысячи за
 * десять минут.
 */
export const LIMITS = {
  anonBatch: 5,
  anon: new WindowLimiter(10, TEN_MIN),
  userBatch: 20,
  user: new WindowLimiter(120, TEN_MIN),
  global: new WindowLimiter(3000, TEN_MIN),
  vitalsBatch: 50,
  vitals: new WindowLimiter(600, TEN_MIN),
};

/** Только для тестов */
export function resetClientLimits(): void {
  LIMITS.anon.reset();
  LIMITS.user.reset();
  LIMITS.global.reset();
  LIMITS.vitals.reset();
}

/* ─────────── ошибки клиента ─────────── */

export const clientErrorItemSchema = z
  .object({
    platform: z.enum(["web", "mobile"]),
    kind: z.enum(["react", "error", "rejection", "network"]),
    name: z.string().max(120),
    message: z.string().max(2000),
    stack: z.string().max(8000).optional(),
    route: z.string().max(400),
    apiMethod: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).optional(),
    apiRoute: z.string().max(400).optional(),
    status: z.number().int().min(0).max(599).optional(),
    release: z
      .string()
      .max(64)
      .regex(/^[\w.+:-]+$/)
      .optional(),
    browser: z.string().max(40).optional(),
    os: z.string().max(40).optional(),
    count: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

export const clientErrorBatchSchema = z.object({ items: z.array(clientErrorItemSchema).min(1).max(20) }).strict();

/** Сколько групп хранится; сверх — новые не заводятся, старые считаются дальше */
export const CLIENT_ERROR_CAPACITY = 1000;

const fingerprintOf = (parts: (string | number | null | undefined)[]) =>
  new Bun.CryptoHasher("sha1").update(parts.map((p) => p ?? "").join("\u0000")).digest("hex").slice(0, 16);

/**
 * Текст ошибки клиента: клиентская чистка, фильтр ошибок техпанели и
 * сверху — любое значение в двойных кавычках.
 *
 * normalizeMessage снимает кавычки после двоеточия — так цитирует ввод
 * Postgres. Браузер цитирует иначе и где попало («Unexpected token "…"»,
 * «value "Іваненко" is not valid»), и введённое человеком в поле формы
 * оказывается посреди фразы. Имя в кавычках ничего не говорит о том, где
 * ошибка, поэтому на клиентских сообщениях кавычки гасятся все.
 */
function clientText(raw: string, max: number): string {
  return normalizeMessage(maskText(raw, max))
    .replace(/"[^"]*"/g, '"?"')
    .replace(/“[^”]*”/g, "“?”")
    .replace(/«[^»]*»/g, "«?»");
}

/** Строка к хранению — или null, если её нельзя хранить вовсе */
export function cleanClientError(e: ClientErrorInput): Omit<OpsClientErrorGroup, "count" | "firstAt" | "lastAt"> & { count: number } | null {
  if (!isClientRoute(e.route)) return null;
  if (e.apiRoute !== undefined && !isClientRoute(e.apiRoute)) return null;
  const name = clientText(e.name, 120).slice(0, 80) || "Error";
  const message = clientText(e.message, 1000);
  const frames = cleanFrames(e.stack);
  /* верхний кадр без строки и колонки: правка соседней строки не делает ошибку другой */
  const top = (frames[0] ?? "").replace(/:\d+(?::\d+)?\)?$/, "");
  const coarse = (v?: string) => (v && COARSE_NAME.test(v) ? v : null);
  return {
    fingerprint: fingerprintOf([e.platform, e.kind, name, message, top, e.route, e.apiMethod, e.apiRoute, e.status]),
    platform: e.platform,
    kind: e.kind,
    name,
    message,
    route: e.route,
    apiMethod: e.apiMethod ?? null,
    apiRoute: e.apiRoute ?? null,
    status: e.status ?? null,
    release: e.release ?? null,
    browser: coarse(e.browser),
    os: coarse(e.os),
    frames,
    count: e.count ?? 1,
  };
}

/**
 * Принять пачку. Вызывается системным контекстом: у экрана входа роли нет.
 * Возвращает, сколько строк принято и сколько отвергнуто как не шаблон.
 */
export async function recordClientErrors(items: ClientErrorInput[], now = new Date()): Promise<{ accepted: number; rejected: number; dropped: number }> {
  const clean = new Map<string, NonNullable<ReturnType<typeof cleanClientError>>>();
  let rejected = 0;
  for (const it of items) {
    const row = cleanClientError(it);
    if (!row) {
      rejected++;
      continue;
    }
    const known = clean.get(row.fingerprint);
    if (known) known.count += row.count;
    else clean.set(row.fingerprint, row);
  }
  if (!clean.size) return { accepted: 0, rejected, dropped: 0 };

  const fps = [...clean.keys()];
  const existing = new Set(
    (await db.select({ fp: opsClientErrors.fingerprint }).from(opsClientErrors).where(inArray(opsClientErrors.fingerprint, fps))).map(
      (r) => r.fp,
    ),
  );
  const [{ n: total } = { n: 0 }] = await db.select({ n: count() }).from(opsClientErrors);
  let room = CLIENT_ERROR_CAPACITY - Number(total);
  let dropped = 0;
  const at = now.toISOString();

  for (const row of clean.values()) {
    if (!existing.has(row.fingerprint)) {
      if (room <= 0) {
        dropped++;
        continue;
      }
      room--;
    }
    await db
      .insert(opsClientErrors)
      .values({ ...row, firstAt: at, lastAt: at })
      .onConflictDoUpdate({
        target: opsClientErrors.fingerprint,
        set: {
          count: sql`${opsClientErrors.count} + ${row.count}`,
          lastAt: at,
          release: row.release,
          browser: row.browser,
          os: row.os,
          /* кадры — если прежних не было: первой могла прийти ошибка без стека */
          frames: sql`case when jsonb_array_length(${opsClientErrors.frames}) = 0 then excluded.frames else ${opsClientErrors.frames} end`,
        },
      });
  }
  return { accepted: clean.size - dropped, rejected, dropped };
}

export async function clientErrorsReport(limit = 200): Promise<OpsClientErrors> {
  const rows = await db.select().from(opsClientErrors).orderBy(sql`${opsClientErrors.lastAt} desc`).limit(limit);
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(opsClientErrors);
  return {
    items: rows.map((r) => ({
      fingerprint: r.fingerprint,
      platform: r.platform,
      kind: r.kind,
      name: r.name,
      message: r.message,
      route: r.route,
      apiMethod: r.apiMethod,
      apiRoute: r.apiRoute,
      status: r.status,
      release: r.release,
      browser: r.browser,
      os: r.os,
      count: r.count,
      firstAt: r.firstAt,
      lastAt: r.lastAt,
      frames: r.frames ?? [],
    })),
    total: Number(n),
    capacity: CLIENT_ERROR_CAPACITY,
    retentionDays: HISTORY_DAYS,
  };
}

/* ─────────── скорость экранов ─────────── */

export const vitalItemSchema = z
  .object({
    metric: z.enum(VITAL_METRICS as [VitalMetric, ...VitalMetric[]]),
    route: z.string().max(400),
    value: z.number().finite().min(0),
  })
  .strict();

export const vitalBatchSchema = z.object({ items: z.array(vitalItemSchema).min(1).max(50) }).strict();

/**
 * Потолок различных маршрутов за период. Маршрутов консоли — меньше сотни;
 * если их вдруг тысячи, это не экраны, а мусор с клиента, и таблица не
 * должна расти из-за него без предела.
 */
export const VITAL_ROUTES_CAP = 400;
export const VITAL_DAYS = 30;

export async function recordVitals(items: VitalInput[], now = new Date()): Promise<{ accepted: number; rejected: number }> {
  const day = dayOf(now.toISOString())!;
  const agg = new Map<string, { route: string; metric: VitalMetric; bucket: number; n: number }>();
  let rejected = 0;
  for (const it of items) {
    if (!isClientRoute(it.route) || it.value > VITAL_MAX[it.metric]) {
      rejected++;
      continue;
    }
    const bucket = vitalBucket(it.metric, it.value);
    const key = `${it.route}\u0000${it.metric}\u0000${bucket}`;
    const a = agg.get(key);
    if (a) a.n++;
    else agg.set(key, { route: it.route, metric: it.metric, bucket, n: 1 });
  }
  if (!agg.size) return { accepted: 0, rejected };

  const since = dayOf(new Date(now.getTime() - VITAL_DAYS * 86_400_000).toISOString())!;
  const known = new Set(
    (await db.selectDistinct({ route: opsVitals.route }).from(opsVitals).where(gte(opsVitals.day, since))).map((r) => r.route),
  );
  let room = VITAL_ROUTES_CAP - known.size;
  const admitted = new Set<string>();
  let accepted = 0;
  for (const a of agg.values()) {
    if (!known.has(a.route) && !admitted.has(a.route)) {
      if (room <= 0) {
        rejected += a.n;
        continue;
      }
      room--;
      admitted.add(a.route);
    }
    await db
      .insert(opsVitals)
      .values({ day, route: a.route, metric: a.metric, bucket: a.bucket, n: a.n })
      .onConflictDoUpdate({
        target: [opsVitals.day, opsVitals.route, opsVitals.metric, opsVitals.bucket],
        set: { n: sql`${opsVitals.n} + ${a.n}` },
      });
    accepted += a.n;
  }
  return { accepted, rejected };
}

/** Дни периода по поясу учреждения, старые первыми, последний — сегодня */
export function periodDays(now: Date, days = VITAL_DAYS): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dayOf(new Date(now.getTime() - i * 86_400_000).toISOString())!);
  /* переход на летнее время может дать один день дважды — оставляем по разу */
  return [...new Set(out)];
}

/**
 * Замеры корзин по оценке. Корзина i — значения до bounds[i] включительно,
 * последняя — всё выше последней границы; пороги оценки стоят среди границ,
 * поэтому оценка верхнего края корзины и есть оценка каждого замера в ней.
 * Приблизительного здесь нет — в отличие от p75, который интерполируется
 * внутри корзины.
 */
export function ratingsOf(metric: VitalMetric, hist: readonly number[]): Record<VitalRating, number> {
  const bounds = VITAL_BOUNDS[metric];
  const out: Record<VitalRating, number> = { good: 0, needs: 0, poor: 0 };
  hist.forEach((n, i) => {
    if (n) out[vitalRating(metric, bounds[i] ?? Number.POSITIVE_INFINITY)] += n;
  });
  return out;
}

const roundVital = (m: VitalMetric, v: number | null) =>
  v === null ? null : m === "CLS" ? Math.round(v * 1000) / 1000 : Math.round(v);

/**
 * Сводка: по каждому маршруту и мере — p75 за период, число замеров,
 * оценка и p75 по дням. Маршруты — по числу замеров, самые посещаемые
 * первыми: медленный экран, который открывают раз в месяц, важен меньше,
 * чем тот, с которого начинается каждый день.
 */
export async function vitalsReport(now = new Date(), days = VITAL_DAYS): Promise<OpsVitals> {
  const period = periodDays(now, days);
  const rows = await db
    .select({ day: opsVitals.day, route: opsVitals.route, metric: opsVitals.metric, bucket: opsVitals.bucket, n: opsVitals.n })
    .from(opsVitals)
    .where(gte(opsVitals.day, period[0]!));

  const dayIdx = new Map(period.map((d, i) => [d, i]));
  type Acc = { total: number[]; perDay: number[][] };
  const byRoute = new Map<string, Map<VitalMetric, Acc>>();
  for (const r of rows) {
    const metric = r.metric as VitalMetric;
    if (!VITAL_METRICS.includes(metric)) continue;
    const di = dayIdx.get(String(r.day).slice(0, 10));
    if (di === undefined) continue;
    const width = VITAL_BOUNDS[metric].length + 1;
    let m = byRoute.get(r.route);
    if (!m) byRoute.set(r.route, (m = new Map()));
    let acc = m.get(metric);
    if (!acc) m.set(metric, (acc = { total: new Array(width).fill(0), perDay: period.map(() => new Array(width).fill(0)) }));
    if (r.bucket < 0 || r.bucket >= width) continue;
    acc.total[r.bucket]! += r.n;
    acc.perDay[di]![r.bucket]! += r.n;
  }

  const routes = [...byRoute.entries()].map(([route, m]) => {
    const metrics: Partial<Record<VitalMetric, OpsVitalCell>> = {};
    let samples = 0;
    for (const [metric, acc] of m) {
      const bounds = VITAL_BOUNDS[metric];
      const n = acc.total.reduce((s, v) => s + v, 0);
      samples += n;
      const p75 = roundVital(metric, histQuantile(acc.total, 0.75, bounds));
      metrics[metric] = {
        p75,
        n,
        rating: p75 === null ? null : vitalRating(metric, p75),
        daily: acc.perDay.map((h) => roundVital(metric, histQuantile(h, 0.75, bounds))),
        ratings: ratingsOf(metric, acc.total),
      };
    }
    return { route, metrics, samples };
  });
  routes.sort((a, b) => b.samples - a.samples || a.route.localeCompare(b.route));
  return { days: period, sampleRate: RUM_SAMPLE_RATE, routes: routes.map(({ route, metrics }) => ({ route, metrics })) };
}
