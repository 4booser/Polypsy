import type {
  OpsCompareStats,
  OpsLogLine,
  OpsPlanState,
  OpsRelease,
  OpsRouteCompare,
  OpsShift,
  OpsStatementSort,
  OpsStatementsState,
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
