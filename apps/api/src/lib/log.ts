/**
 * Структурный лог и сквозной идентификатор запроса.
 *
 * Без идентификатора разбор жалобы «у Иванова вчера вечером не сохранилось
 * прохождение» начинается с гадания по текстовому логу. С ним человек
 * называет номер с экрана ошибки, и запись находится одним поиском.
 *
 * Строки, а не JSON, в разработке: читать глазами важнее, чем разбирать
 * машиной. В production наоборот.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../env";

const store = new AsyncLocalStorage<{ requestId: string }>();

/** Идентификатор текущего запроса; вне запроса — null */
export function currentRequestId(): string | null {
  return store.getStore()?.requestId ?? null;
}

export function withRequestId<T>(requestId: string, fn: () => T): T {
  return store.run({ requestId }, fn);
}

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? (env.isProduction ? "info" : "debug")] ?? 20;

/**
 * Запись в лог.
 *
 * В поля кладём только то, что не является персональными данными: маршрут,
 * роль, длительность, код. Ни тел запросов, ни имён — лог уходит в файлы и
 * системы сбора, где режим доступа не такой, как у базы.
 */
function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold) return;
  const requestId = currentRequestId();
  const entry = { level, message, ...(requestId ? { requestId } : {}), ...fields };

  if (env.isProduction) {
    console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
    return;
  }
  const tail = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  const head = requestId ? `[${requestId.slice(0, 8)}]` : "";
  console.log(`${level.toUpperCase().padEnd(5)} ${head} ${message}${tail ? " " + tail : ""}`);
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => write("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
};
