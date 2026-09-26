/**
 * Реестр фоновых задач процесса: что тикает, когда тикало, чем кончилось.
 *
 * Планировщик (scheduler.ts), рассыльщик (notify.ts) и чистка (retention.ts)
 * ничего о своих тактах не помнят: проход запускается и либо молча
 * отрабатывает, либо пишет строку в лог. На вопрос «рассылка тревог вообще
 * ходит?» ответить было нечем, кроме поиска по логу, — а таблица
 * schedule_runs отвечает только за расписания и только когда какое-то из
 * них сработало. Пустой тик в ней не оставляет следа, так что «планировщик
 * встал» и «сегодня никому не пора» выглядят одинаково.
 *
 * Здесь — маленький реестр в памяти, который задачи отмечают сами, одной
 * обёрткой вокруг прохода (trackJob). Живёт до перезапуска, как и остальная
 * память техпанели: экран говорит «з моменту запуску».
 */
import type { OpsJob, OpsJobResult } from "@quizzy/shared";
import { normalizeMessage } from "./opsBuffer";

interface JobState {
  name: string;
  intervalMs: number;
  /** Когда таймер заведён: от него считается следующий такт */
  since: number;
  runs: number;
  failures: number;
  skipped: number;
  running: boolean;
  lastStartAt: number | null;
  lastEndAt: number | null;
  lastDurationMs: number | null;
  lastResult: OpsJobResult | null;
  lastError: string | null;
  lastErrorAt: number | null;
}

const jobs = new Map<string, JobState>();

/**
 * Задача заведена с таким-то шагом. Зовётся там, где ставится setInterval:
 * шаг берётся настоящий, а не переписанный сюда вторым числом.
 */
export function registerJob(name: string, intervalMs: number, now = Date.now()): void {
  const known = jobs.get(name);
  if (known) {
    known.intervalMs = intervalMs;
    known.since = now;
    return;
  }
  jobs.set(name, {
    name,
    intervalMs,
    since: now,
    runs: 0,
    failures: 0,
    skipped: 0,
    running: false,
    lastStartAt: null,
    lastEndAt: null,
    lastDurationMs: null,
    lastResult: null,
    lastError: null,
    lastErrorAt: null,
  });
}

function stateOf(name: string): JobState {
  let s = jobs.get(name);
  if (!s) {
    /* проход, запущенный мимо registerJob (тест, ручной вызов), тоже виден — без шага */
    registerJob(name, 0);
    s = jobs.get(name)!;
  }
  return s;
}

/**
 * Проход под наблюдением. Результат и исключение пробрасываются как есть:
 * обёртка ничего не глотает, обработка ошибок остаётся у вызывающего.
 * Текст ошибки хранится вычищенным (normalizeMessage) — он показывается на
 * экране того, кому пациенты не положены.
 */
export async function trackJob<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const s = stateOf(name);
  const started = Date.now();
  s.running = true;
  s.lastStartAt = started;
  s.lastResult = "running";
  try {
    const out = await fn();
    s.lastResult = "ok";
    return out;
  } catch (error) {
    s.failures++;
    s.lastResult = "error";
    s.lastError = normalizeMessage(error instanceof Error ? error.message : String(error));
    s.lastErrorAt = Date.now();
    throw error;
  } finally {
    s.runs++;
    s.running = false;
    s.lastEndAt = Date.now();
    s.lastDurationMs = s.lastEndAt - started;
  }
}

/** Такт пропущен: предыдущий проход ещё идёт (рассыльщик не накладывает такты) */
export function skipJob(name: string): void {
  const s = stateOf(name);
  s.skipped++;
  if (!s.running) s.lastResult = "skipped";
}

/** Когда задача последний раз начинала проход; null — ни разу в этом процессе */
export function lastStartOf(name: string): number | null {
  return jobs.get(name)?.lastStartAt ?? null;
}

export function intervalOf(name: string): number | null {
  return jobs.get(name)?.intervalMs || null;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function jobsSnapshot(now = Date.now()): OpsJob[] {
  return [...jobs.values()].map((s) => {
    /* следующий такт setInterval — ближайшее кратное шагу от момента заведения */
    const next =
      s.intervalMs > 0 ? s.since + Math.max(1, Math.ceil((now - s.since) / s.intervalMs)) * s.intervalMs : null;
    return {
      name: s.name,
      intervalSec: Math.round(s.intervalMs / 1000),
      runs: s.runs,
      failures: s.failures,
      skipped: s.skipped,
      lastStartAt: iso(s.lastStartAt),
      lastEndAt: iso(s.lastEndAt),
      lastDurationMs: s.lastDurationMs,
      lastResult: s.running ? "running" : s.lastResult,
      lastError: s.lastError,
      lastErrorAt: iso(s.lastErrorAt),
      nextAt: iso(next),
    };
  });
}

/** Только для тестов */
export function resetJobs(): void {
  jobs.clear();
}
