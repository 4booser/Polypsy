import type {
  OpsCompareStats,
  OpsLogLine,
  OpsPlanState,
  OpsRelease,
  OpsRouteCompare,
  OpsShift,
  OpsStatement,
  OpsStatementSort,
  OpsStatementsState,
  OpsTraceSummary,
  UiKey,
} from "@quizzy/shared";
import type { Tone } from "../parts";

/**
 * Чистая логика второй половины техпанели (участок obs2a): трасса,
 * сравнение выкаток, медленные SQL. Без React и без «сейчас» внутри —
 * локаль приходит аргументом (apps/web/test/opsObs2a.test.ts).
 */

/* ─────────── номер запроса ─────────── */

/**
 * Номер из поля поиска: без пробелов по краям, тот же алфавит, что
 * принимает сервер (middleware/requestId.ts). null — искать нечего; экран
 * скажет «такого номера не бывает» до запроса, а не после 400.
 */
export function parseRequestId(input: string): string | null {
  const id = input.trim();
  return /^[A-Za-z0-9._:-]{4,64}$/.test(id) ? id : null;
}

/** Исход записи журнала словом; неизвестный код (сервер новее консоли) печатается как есть */
export const OUTCOME_KEY: Partial<Record<string, UiKey>> = {
  success: "ops.trace.outcome.success",
  denied: "ops.trace.outcome.denied",
  error: "ops.trace.outcome.error",
};

/** Смещение каждой строки от первой строки запроса, мс: «что за чем и через сколько» */
export function offsets(lines: readonly OpsLogLine[]): number[] {
  if (!lines.length) return [];
  const t0 = Date.parse(lines[0]!.at);
  return lines.map((l) => Math.max(0, Date.parse(l.at) - t0));
}

/* ─────────── выкатки ─────────── */

/**
 * Цвет сдвига. Янтарь — только «гірше»: он значит «требует внимания».
 * «Краще» — порядок, фиолетовым; «без змін» и «замало» — тихо. Слово
 * рядом с меткой обязательно: цвет в одиночку сдвиг не несёт.
 */
export const SHIFT_TONE: Record<OpsShift, Tone> = { worse: "warn", better: "ok", same: "quiet", few: "quiet" };

export const SHIFT_KEY: Record<OpsShift, UiKey> = {
  worse: "ops.rel.worse",
  better: "ops.rel.better",
  same: "ops.rel.same",
  few: "ops.rel.few",
};

/** Строки, где хоть что-то стало заметно хуже — отбор «лише погіршення» */
export function onlyWorse(items: readonly OpsRouteCompare[]): OpsRouteCompare[] {
  return items.filter((i) => i.latency === "worse" || i.errors === "worse");
}

export function filterCompare(items: readonly OpsRouteCompare[], q: string): OpsRouteCompare[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return items.slice();
  return items.filter((i) => `${i.method} ${i.route}`.toLowerCase().includes(needle));
}

/**
 * Пара по умолчанию, пока человек не выбрал: «после» — версия этого
 * процесса, если о ней уже есть суммы, иначе самая новая; «до» — ближайшая
 * старшая. Так же выбирает и сервер; здесь — чтобы выпадающие списки
 * показывали выбранное, а не пустоту.
 */
export function defaultPair(items: readonly OpsRelease[], current: string): { before: string | null; after: string | null } {
  if (!items.length) return { before: null, after: null };
  const byNew = items.slice().sort((a, b) => (a.firstAt < b.firstAt ? 1 : a.firstAt > b.firstAt ? -1 : 0));
  const after = byNew.find((r) => r.version === current) ?? byNew[0]!;
  const before = byNew.find((r) => r.firstAt < after.firstAt) ?? null;
  return { before: before?.version ?? null, after: after.version };
}

/** Разница p95 «после − до», мс; null — сравнивать нечего */
export function p95Delta(b: OpsCompareStats | null, a: OpsCompareStats | null): number | null {
  if (!b || !a || b.p95 === null || a.p95 === null) return null;
  return a.p95 - b.p95;
}

/** Та же разница относительно «до»; при нуле «до» — null: «с нуля на сколько-то процентов» не бывает */
export function p95Ratio(b: OpsCompareStats | null, a: OpsCompareStats | null): number | null {
  const d = p95Delta(b, a);
  if (d === null || !b!.p95) return null;
  return d / b!.p95;
}

/** Разница доли 5xx «после − до», в долях (0.01 — процентный пункт) */
export function shareDelta(b: OpsCompareStats | null, a: OpsCompareStats | null): number | null {
  if (!b || !a || b.share5xx === null || a.share5xx === null) return null;
  return a.share5xx - b.share5xx;
}

/** «+380 мс», «−12 мс», «0 мс» — со знаком, единица через Intl */
export function fmtSignedMs(n: number, loc: string): string {
  return new Intl.NumberFormat(loc, {
    style: "unit",
    unit: "millisecond",
    unitDisplay: "short",
    maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0,
    signDisplay: "exceptZero",
  }).format(n);
}

/** «+45 %» — относительное изменение со знаком */
export function fmtSignedPct(ratio: number, loc: string): string {
  return new Intl.NumberFormat(loc, { style: "percent", maximumFractionDigits: 0, signDisplay: "exceptZero" }).format(ratio);
}

/** Процентные пункты числом со знаком: «+1,5», «−0,4» — подпись «п.п.» добавляет словарь */
export function fmtSignedPp(delta: number, loc: string): string {
  return new Intl.NumberFormat(loc, { maximumFractionDigits: 1, signDisplay: "exceptZero" }).format(delta * 100);
}

/* ─────────── медленные SQL ─────────── */

export const STATEMENT_SORTS: readonly OpsStatementSort[] = ["total", "calls", "mean"];

export const parseStatementSort = (v: string | null): OpsStatementSort =>
  (STATEMENT_SORTS as readonly string[]).includes(v ?? "") ? (v as OpsStatementSort) : "total";

/** Пояснение к состоянию раздела; для ok пояснения нет */
export const STATEMENTS_STATE_KEY: Record<Exclude<OpsStatementsState, "ok">, UiKey> = {
  notInstalled: "ops.sql.state.notInstalled",
  notLoaded: "ops.sql.state.notLoaded",
  denied: "ops.sql.state.denied",
  failed: "ops.sql.state.failed",
};

export const PLAN_STATE_KEY: Record<Exclude<OpsPlanState, "ok">, UiKey> = {
  notFound: "ops.sql.plan.notFound",
  refused: "ops.sql.plan.refused",
  needsPg16: "ops.sql.plan.needsPg16",
  denied: "ops.sql.plan.denied",
  failed: "ops.sql.plan.failed",
  unavailable: "ops.sql.plan.unavailable",
};

/**
 * Какие шаги включения показать. notInstalled — оба (загрузить и создать),
 * notLoaded — только загрузить: расширение уже создано миграцией; denied —
 * выдать право. Шаги — код, а не фраза: их копируют в терминал.
 */
export function enableSteps(state: OpsStatementsState): ("preload" | "create" | "grant")[] {
  if (state === "notInstalled") return ["preload", "create"];
  if (state === "notLoaded") return ["preload"];
  if (state === "denied") return ["grant"];
  return [];
}

/** Величина, по которой отсортировано и нарисована полоска строки */
export function statementMetric(s: { calls: number; totalMs: number; meanMs: number }, sort: OpsStatementSort): number {
  return sort === "calls" ? s.calls : sort === "mean" ? s.meanMs : s.totalMs;
}

/* ─────────── графики (волна 11) ─────────── */

/*
 * Ряды графиков сравнения выкаток, медленных SQL и трассы. Чистые функции,
 * как всё в этом файле (apps/web/test/opsCharts.test.ts).
 */

/**
 * Маршруты для пар «p95 було / стало»: только те, где сравнивать есть что
 * (обе стороны известны и запросов не меньше порога — «замало» на график
 * не идёт, как и в проценты), по величине сдвига — в любую сторону: заметно
 * ускорившийся маршрут — тоже новость выкатки.
 */
export function latencyPairs(items: readonly OpsRouteCompare[], n = 8): OpsRouteCompare[] {
  return items
    .filter((i) => i.latency !== "few" && i.before?.p95 != null && i.after?.p95 != null)
    .sort((a, b) => Math.abs(p95Delta(b.before, b.after)!) - Math.abs(p95Delta(a.before, a.after)!) || a.route.localeCompare(b.route))
    .slice(0, n);
}

/**
 * Маршруты для пар «частка 5xx було / стало»: только где пятисотки были хоть
 * в одном окне. Маршрут без единой пятисотки до и после — ноль рядом с
 * нулём, и восемь таких строк спрятали бы одну настоящую.
 */
export function errorPairs(items: readonly OpsRouteCompare[], n = 8): OpsRouteCompare[] {
  return items
    .filter((i) => i.errors !== "few" && i.before?.share5xx != null && i.after?.share5xx != null)
    .filter((i) => i.before!.errors5xx + i.after!.errors5xx > 0)
    .sort((a, b) => b.after!.share5xx! - a.after!.share5xx! || Math.abs(shareDelta(b.before, b.after)!) - Math.abs(shareDelta(a.before, a.after)!))
    .slice(0, n);
}

/** Первые N запросов по текущему порядку и сколько ещё в списке */
export function statementsTop(items: readonly OpsStatement[], sort: OpsStatementSort, n = 8): { top: OpsStatement[]; rest: number } {
  const sorted = items.slice().sort((a, b) => statementMetric(b, sort) - statementMetric(a, sort));
  return { top: sorted.slice(0, n), rest: Math.max(0, sorted.length - n) };
}

/**
 * Доля суммарного времени базы: первые N запросов и «решта». Остаток —
 * от единицы, а не от списка: в `share` доля от ВСЕХ запросов своей базы,
 * и то, что в список не попало, — тоже время базы. null — долей нет
 * (статистика без общего времени), и полосу не из чего строить.
 */
export function statementShares(items: readonly OpsStatement[], n = 5): { top: OpsStatement[]; rest: number } | null {
  const known = items.filter((s) => s.share !== null).sort((a, b) => b.share! - a.share!);
  if (!known.length) return null;
  const top = known.slice(0, n);
  return { top, rest: Math.max(0, 1 - top.reduce((s, x) => s + x.share!, 0)) };
}

/**
 * Куда ушло время запроса: SQL и всё остальное. Запросы к базе внутри
 * одного обращения идут по очереди, но драйвер меряет их со своей
 * стороны, и сумма может на миллисекунду перерасти итог — тогда «решта»
 * ноль, а не минус.
 */
export function traceTime(s: OpsTraceSummary | null): { sql: number; other: number } | null {
  if (!s || s.ms === null || s.sqlMs === null || s.ms <= 0) return null;
  const sqlMs = Math.min(s.sqlMs, s.ms);
  return { sql: sqlMs, other: s.ms - sqlMs };
}
