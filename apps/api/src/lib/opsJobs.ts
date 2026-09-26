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
  /** Последний проход запущен руками (участок obs2b) */
  lastByHand: boolean;
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
    lastByHand: false,
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
  s.lastByHand = false;
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
  const known = [...jobs.values()].map((s) => {
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
      manual: runnables.has(s.name),
      lastByHand: s.lastByHand,
    };
  });
  /*
   * Задачи, которые можно запустить руками, видны и до первого прохода:
   * переиндексация и установка каталога тактов не имеют вовсе, и без этого
   * кнопку «Запустити зараз» негде было бы нажать в первый раз.
   */
  const idle: OpsJob[] = [...runnables.keys()]
    .filter((name) => !jobs.has(name))
    .map((name) => ({
      name,
      intervalSec: 0,
      runs: 0,
      failures: 0,
      skipped: 0,
      lastStartAt: null,
      lastEndAt: null,
      lastDurationMs: null,
      lastResult: null,
      lastError: null,
      lastErrorAt: null,
      nextAt: null,
      manual: true,
      lastByHand: false,
    }));
  return [...known, ...idle];
}

/* ─────────── ручной запуск (участок obs2b) ─────────── */

/**
 * Задачи, которые можно запустить руками из техпанели.
 *
 * Решение заказчика 2026-09-26: «Запустити зараз» у задач, которые
 * безопасно запускать вне такта. Реестр — здесь, рядом с тактами, а не
 * отдельный: ручной проход — тот же проход той же задачи, и на экране он
 * должен быть той же строкой, с тем же «виконується», итогом и ошибкой.
 * Что именно регистрируется и почему безопасно — lib/opsManual.ts.
 */
const runnables = new Map<string, () => Promise<unknown>>();

export function registerRunnable(name: string, run: () => Promise<unknown>): void {
  runnables.set(name, run);
}

export function isRunnable(name: string): boolean {
  return runnables.has(name);
}

/** Идёт ли проход задачи в этом процессе — тактом или руками */
export function isRunning(name: string): boolean {
  return jobs.get(name)?.running ?? false;
}

/**
 * Запустить руками — фоном, не в запросе.
 *
 * Ответ уходит сразу («запущено»), а проход идёт своим ходом: переиндексация
 * на десятках тысяч записей — минуты, и держать запрос открытым всё это
 * время значило бы держать и соединение из пула, и терпение прокси.
 * Итог — в реестре: строка задачи покажет «виконується», потом итог или
 * ошибку, как у прохода по такту.
 *
 * Один проход за раз: пока идёт прошлый (руками или тактом), второй не
 * начинается — «running». Это граница процесса; между репликами задачу
 * держит транзакционный замок внутри самой задачи (lib/opsManual.ts).
 */
export function startManual(name: string, onError?: (error: unknown) => void): "started" | "running" | "unknown" {
  const run = runnables.get(name);
  if (!run) return "unknown";
  if (isRunning(name)) return "running";
  const pass = trackJob(name, run);
  /* trackJob выставил running синхронно; отметку «руками» — поверх неё */
  stateOf(name).lastByHand = true;
  pass.catch((error) => onError?.(error));
  return "started";
}

/** Только для тестов */
export function resetJobs(): void {
  jobs.clear();
}
