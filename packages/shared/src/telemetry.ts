import type { ClientErrorInput, OpsAlertRuleKey, VitalMetric, VitalRating } from "./types";

/**
 * Телеметрия интерфейса — общее для консоли, мобилки и сервера.
 *
 * Решение заказчика 2026-09-26: техпанели нужны ошибки клиента (падения
 * экранов, сетевые сбои) и скорость экранов (Web Vitals). Всё это приходит
 * из браузера и телефона человека, работающего с клиническими данными, —
 * поэтому правило одно: ни адреса с идентификатором, ни текста поля, ни
 * имени, ни почты. Здесь — то, чем это правило выполняется с обеих сторон.
 *
 * Клиент чистит перед отправкой, сервер проверяет и чистит ещё раз. Одних
 * клиентских правил мало: старая сборка консоли или чужой клиент пришлют
 * что угодно. Одних серверных — тоже: адрес с идентификатором не должен
 * даже уходить по сети, если его можно не отправлять. Поэтому функции общие,
 * а не написаны дважды: разойтись двум копиям правила было бы проще всего.
 */

/* ─────────── адрес шаблоном ─────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Похож ли сегмент адреса на идентификатор.
 *
 * UUID, чистое число, почта; длинная смесь букв и цифр (токен приглашения,
 * код, хэш); всё, где есть «%» или не-ASCII — туда попадает свободный текст,
 * в том числе фамилия, набранная в поиске. Правило нарочно широкое: лишний
 * «:id» в шаблоне стоит строки отчёта, пропущенный — чужой тайны.
 */
export function isIdSegment(seg: string): boolean {
  if (!seg) return false;
  if (UUID.test(seg)) return true;
  if (/^\d+$/.test(seg)) return true;
  if (/[@%]/.test(seg)) return true;
  if (/[^\x20-\x7e]/.test(seg)) return true;
  if (seg.length >= 12 && /\d/.test(seg)) return true;
  if (seg.length >= 32) return true;
  return false;
}

/** Предел длины шаблона: длиннее — это уже не маршрут, а что-то приклеенное к нему */
export const ROUTE_MAX = 160;

/**
 * Адрес → шаблон маршрута: `/patients/7c9e…/case?tab=1` → `/patients/:id/case`.
 *
 * Запрос и якорь отрезаются целиком — в них фильтры и поиск, то есть ровно
 * то, что человек набирал. Абсолютный адрес сводится к пути.
 */
export function routeTemplate(path: string): string {
  const bare = (path.split(/[?#]/)[0] ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");
  const segs = bare.split("/").map((s) => (s.startsWith(":") ? s : isIdSegment(s) ? ":id" : s));
  const out = segs.join("/") || "/";
  return out.length > ROUTE_MAX ? out.slice(0, ROUTE_MAX) : out;
}

/**
 * Шаблон ли это — проверка на входе сервера.
 *
 * Не «приведи к шаблону», а «откажи, если не шаблон»: адрес с
 * идентификатором, пришедший от клиента, значит, что клиент правило не
 * выполнил, и склеивать за него — значит молча принять то, чего принимать
 * нельзя.
 */
/*
 * Своё имя, а не isRouteTemplate: одноимённая проверка из usage.ts
 * (счётчики экранов) строже к хвостовой косой и к «*», и обе живут в одном
 * пакете. Две функции с одним именем в одном экспорте — это не «одно
 * правило», а случай, кто из них победит при сборке.
 */
export function isClientRoute(route: string): boolean {
  if (!route.startsWith("/") || route.length > ROUTE_MAX) return false;
  if (/[?#@%\s]/.test(route)) return false;
  return route
    .split("/")
    .every((s) => s === "" || (s.startsWith(":") ? /^:[A-Za-z]\w{0,30}$/.test(s) : /^[\w.~()-]+$/.test(s) && !isIdSegment(s)));
}

/* ─────────── текст без данных ─────────── */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/* те же телефоны, что маскирует лог техпанели (apps/api/src/lib/opsBuffer.ts) */
const PHONE = /(?<![\w+])(?:\+?380|0)\d{9}(?!\d)|\+\d{10,14}(?!\d)/g;
const UUID_IN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_IN = /\b(?:https?|blob|file):\/\/[^\s)'"<>]+/gi;

/**
 * Адрес внутри текста (кадр стека, сообщение fetch) — без хоста и запроса.
 *
 * Хост говорит об установке, а не об ошибке, и одна ошибка на двух
 * установках иначе стала бы двумя группами; в запросе — фильтры человека.
 * Хвост «:строка:колонка» кадра сохраняется: без него кадр бесполезен.
 *
 * Путь не приводится к шаблону целиком: имя собранного файла
 * («index-DkJ3f8a2.js») похоже на идентификатор по правилу isIdSegment, но
 * это имя сборки, а не человека, — и без него кадр не найти в исходниках.
 * Закодированные сегменты («%D0%86…» — набранный текст) заменяются.
 */
function bareUrl(url: string): string {
  const pos = /(:\d+(?::\d+)?)$/.exec(url)?.[1] ?? "";
  const body = pos ? url.slice(0, -pos.length) : url;
  const path = (body.replace(/^[a-z]+:\/\/[^/]*/i, "").split(/[?#]/)[0] ?? "")
    .replace(/^\//, "")
    .split("/")
    .map((s) => (/%[0-9A-Fa-f]{2}|@/.test(s) || /^\d+$/.test(s) ? ":id" : s))
    .join("/");
  return `${path}${pos}`;
}

/**
 * Текст ошибки для отправки: без адресов с хостом и запросом, почты,
 * телефонов и UUID, не длиннее `max`.
 *
 * На сервере поверх этого идёт normalizeMessage техпанели — тот же фильтр,
 * что у серверных ошибок, — так что две сборки консоли с разной версией
 * этой функции всё равно сходятся в одну группу.
 */
export function maskText(s: string, max = 500): string {
  const out = s
    .replace(URL_IN, bareUrl)
    .replace(EMAIL, "[email]")
    .replace(PHONE, "[phone]")
    .replace(UUID_IN, ":id");
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

/** Строка стека — кадр ли это (Chrome/V8: «at …», Firefox/Safari/Hermes: «fn@url:1:2») */
export function isFrameLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("at ") || /@\S*:\d+(?::\d+)?$/.test(t) || /^\S*:\d+:\d+$/.test(t);
}

/** Кадры стека вычищенными: без хоста, запроса и данных; не больше 15 по 200 знаков */
export function cleanFrames(stack: string | undefined | null): string[] {
  if (!stack) return [];
  return stack
    .split("\n")
    .filter(isFrameLine)
    .slice(0, 15)
    .map((l) => maskText(l.trim(), 200));
}

/* ─────────── браузер и ОС грубо ─────────── */

/**
 * «Chrome 128», «Firefox 131», «Safari 18», «Edge 128» — семейство и
 * старшая версия, и ничего больше: полная строка агента вместе с
 * расширениями и сборкой ОС отличает одного человека от другого лучше,
 * чем кажется.
 */
export function coarseBrowser(ua: string): string | undefined {
  const pick = (re: RegExp, name: string) => {
    const m = re.exec(ua);
    return m ? `${name} ${m[1]}` : undefined;
  };
  return (
    pick(/Edg\/(\d+)/, "Edge") ??
    pick(/OPR\/(\d+)/, "Opera") ??
    pick(/Firefox\/(\d+)/, "Firefox") ??
    pick(/Chrome\/(\d+)/, "Chrome") ??
    (/Safari\//.test(ua) ? pick(/Version\/(\d+)/, "Safari") : undefined)
  );
}

export function coarseOs(ua: string): string | undefined {
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua)) return "Linux";
  return undefined;
}

/** Грубое имя на входе сервера: буквы, пробел, точка и не больше одного числа */
export const COARSE_NAME = /^[A-Za-z][A-Za-z .]{0,23}(?: \d{1,4})?$/;

/* ─────────── накопитель отправки ─────────── */

/** Ключ склейки на клиенте: одинаковые ошибки за время накопления — одна строка с числом */
export function clientErrorKey(e: ClientErrorInput): string {
  return [e.kind, e.name, e.message, e.route, e.apiMethod ?? "", e.apiRoute ?? "", e.status ?? ""].join("\u0000");
}

export interface BufferOptions<T> {
  /** Сколько штук уходит одной отправкой */
  maxBatch: number;
  /** Сколько держать в ожидании; сверх — отбрасывается и считается */
  maxBuffered: number;
  /** Сколько всего за сессию; дальше клиент замолкает — сломанный экран не должен заваливать сервер */
  sessionCap: number;
  keyOf?: (item: T) => string;
  /** Склейка повтора с уже ждущим: у ошибок — счётчик */
  merge?: (kept: T, next: T) => T;
}

/**
 * Накопитель пачек: склейка повторов, потолок ожидания и потолок сессии.
 *
 * Чистый — без таймеров и сети: когда отправлять, решает обвязка (консоль,
 * мобилка), а здесь — что отправлять. Так правило «экран, падающий в
 * цикле, не шлёт тысячу запросов» проверяется тестом без браузера.
 */
export class TelemetryBuffer<T> {
  private queue: T[] = [];
  private byKey = new Map<string, number>();
  private taken = 0;
  dropped = 0;

  constructor(private readonly opts: BufferOptions<T>) {}

  get size(): number {
    return this.queue.length;
  }

  /** Положить; false — отброшено потолком */
  add(item: T): boolean {
    const key = this.opts.keyOf?.(item);
    if (key !== undefined && this.opts.merge) {
      const at = this.byKey.get(key);
      if (at !== undefined) {
        this.queue[at] = this.opts.merge(this.queue[at]!, item);
        return true;
      }
    }
    if (this.queue.length >= this.opts.maxBuffered || this.taken + this.queue.length >= this.opts.sessionCap) {
      this.dropped++;
      return false;
    }
    if (key !== undefined) this.byKey.set(key, this.queue.length);
    this.queue.push(item);
    return true;
  }

  /** Забрать пачку на отправку; `limit` — если сейчас можно меньше обычного (без входа — пять) */
  take(limit = this.opts.maxBatch): T[] {
    const batch = this.queue.splice(0, Math.min(limit, this.opts.maxBatch));
    this.taken += batch.length;
    this.byKey.clear();
    if (this.opts.keyOf) this.queue.forEach((it, i) => this.byKey.set(this.opts.keyOf!(it), i));
    return batch;
  }
}

/* ─────────── скорость экранов ─────────── */

export const VITAL_METRICS: readonly VitalMetric[] = ["LCP", "INP", "CLS", "TTFB", "NAV"];

/**
 * Доля сессий, которые меряются. Пятая часть: на отделение из двадцати
 * человек этого хватает на p75 по основным экранам за неделю, а телеметрия
 * при этом не становится заметной нагрузкой ни на сеть, ни на базу.
 */
export const RUM_SAMPLE_RATE = 0.2;

/**
 * Пороги оценки. LCP, INP, CLS, TTFB — пороги Web Vitals (web.dev): до
 * `good` — «добре», до `poor` — «потребує уваги», выше — «погано».
 * NAV — своя мера, и пороги её наши: секунда до стабильного экрана
 * ощущается как «сразу», три — как «повисло».
 */
export const VITAL_THRESHOLDS: Record<VitalMetric, { good: number; poor: number }> = {
  LCP: { good: 2500, poor: 4000 },
  INP: { good: 200, poor: 500 },
  CLS: { good: 0.1, poor: 0.25 },
  TTFB: { good: 800, poor: 1800 },
  NAV: { good: 1000, poor: 3000 },
};

/**
 * Верхние границы корзин. Сервер хранит не замеры, а число замеров в
 * корзине за день по маршруту: p75 из корзин считается так же, как
 * перцентили нагрузки в техпанели (histogram_quantile). Пороги оценки —
 * среди границ, поэтому оценка p75 не зависит от интерполяции внутри
 * корзины.
 */
export const VITAL_BOUNDS: Record<VitalMetric, readonly number[]> = {
  LCP: [250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 7000, 10000, 20000],
  INP: [25, 50, 100, 150, 200, 300, 400, 500, 750, 1000, 2000],
  CLS: [0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.35, 0.5, 1],
  TTFB: [100, 200, 400, 600, 800, 1000, 1200, 1800, 2500, 4000],
  NAV: [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 15000],
};

/** Больше этого значения замер не принимается: минута до LCP — это вкладка в фоне, а не скорость экрана */
export const VITAL_MAX: Record<VitalMetric, number> = {
  LCP: 120_000,
  INP: 60_000,
  CLS: 10,
  TTFB: 120_000,
  NAV: 120_000,
};

export function vitalRating(metric: VitalMetric, value: number): VitalRating {
  const t = VITAL_THRESHOLDS[metric];
  return value <= t.good ? "good" : value <= t.poor ? "needs" : "poor";
}

/** Номер корзины: первая граница, не меньшая значения; последняя — всё, что выше */
export function vitalBucket(metric: VitalMetric, value: number): number {
  const bounds = VITAL_BOUNDS[metric];
  const i = bounds.findIndex((b) => value <= b);
  return i === -1 ? bounds.length : i;
}

/**
 * Перцентиль по корзинам: корзина, где накопленная доля переходит q, и
 * линейно внутри неё. Выше последней границы интерполировать не к чему —
 * отдаётся сама граница (оценка там «погано» при любом раскладе). Пусто —
 * null, а не ноль: «замеров нет» не то же, что «мгновенно».
 */
export function histQuantile(hist: readonly number[], q: number, bounds: readonly number[]): number | null {
  const total = hist.reduce((s, n) => s + n, 0);
  if (!total) return null;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < hist.length; i++) {
    const n = hist[i] ?? 0;
    if (!n) continue;
    if (cum + n >= rank) {
      if (i >= bounds.length) return bounds[bounds.length - 1] ?? null;
      const lo = i === 0 ? 0 : bounds[i - 1]!;
      const hi = bounds[i]!;
      return lo + ((rank - cum) / n) * (hi - lo);
    }
    cum += n;
  }
  return bounds[bounds.length - 1] ?? null;
}

/* ─────────── пределы правил оповещений ─────────── */

/**
 * Пределы порогов по правилу — общие для сервера (проверка правки) и
 * консоли (подсказка и проверка до отправки). Порог «0 % свободного места»
 * не оповестит никогда, «0,01 % пятисоток» — на каждую; окно у правила без
 * окна не значит ничего, и сервер его отвергает, а не молча хранит.
 *
 * Единицы: errors5xx и diskFree — проценты, p95 — миллисекунды,
 * schedulerSilent — минуты; окно и повтор — минуты.
 */
export const OPS_RULE_LIMITS: Record<OpsAlertRuleKey, { threshold: [number, number] | null; window: [number, number] | null }> = {
  errors5xx: { threshold: [0.1, 100], window: [1, 1440] },
  p95: { threshold: [50, 60_000], window: [1, 1440] },
  schedulerSilent: { threshold: [10, 10_080], window: null },
  diskFree: { threshold: [1, 90], window: null },
  auditChain: { threshold: null, window: null },
};
export const OPS_REPEAT_LIMITS: [number, number] = [5, 10_080];
