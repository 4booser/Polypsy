/**
 * Отправка ошибок во внешний сборщик (Sentry / GlitchTip).
 *
 * Своя отправка, а не SDK: официальный клиент по умолчанию собирает тела
 * запросов, заголовки и переменные окружения — то есть ровно то, чего в
 * отчёте об ошибке из медицинской системы быть не должно. Проще отправить
 * пять полей самому, чем убедить чужую библиотеку ничего лишнего не брать.
 *
 * Что уходит: тип и сообщение ошибки, стек, маршрут, метод, роль, номер
 * запроса. Что не уходит никогда: тело запроса, заголовки, параметры пути,
 * идентификаторы людей, ФИО.
 *
 * Выключено, пока не задан SENTRY_DSN.
 */
import { currentRequestId, log } from "./log";
import { env } from "../env";

interface Report {
  error: Error;
  route: string;
  method: string;
  role?: string;
}

/** Поля, которые нельзя отправлять наружу ни при каких условиях */
const FORBIDDEN = ["body", "headers", "cookies", "email", "firstName", "lastName", "birthDate", "answers"];

/**
 * Собирает событие в формате Sentry.
 *
 * Отдельная функция ради теста: проверка «в полезной нагрузке нет
 * персональных данных» должна работать без сети и без внешнего сервиса.
 */
export function buildEvent(input: Report): Record<string, unknown> {
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: new Date().toISOString(),
    platform: "node",
    level: "error",
    environment: env.isProduction ? "production" : "development",
    logger: "quizzy",
    transaction: `${input.method} ${input.route}`,
    tags: {
      route: input.route,
      method: input.method,
      ...(input.role ? { role: input.role } : {}),
    },
    // номер запроса — единственная нить к конкретному случаю, и он не
    // персональный: по нему находится запись в нашем логе, а не человек
    extra: { requestId: currentRequestId() ?? undefined },
    exception: {
      values: [
        {
          type: input.error.name,
          value: input.error.message,
          stacktrace: { frames: framesOf(input.error) },
        },
      ],
    },
  };
}

/** Стек строками: разбирать его на кадры ради красоты в интерфейсе незачем */
function framesOf(error: Error) {
  return (error.stack ?? "")
    .split("\n")
    .slice(1, 21)
    .map((line) => ({ filename: line.trim() }));
}

/** Есть ли в событии что-то из запрещённого списка — на любой глубине */
export function containsPersonalData(event: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (node: unknown): string | null => {
    if (!node || typeof node !== "object" || seen.has(node)) return null;
    seen.add(node);
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (FORBIDDEN.includes(k)) return k;
      const deeper = walk(v);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(event);
}

export async function reportError(input: Report): Promise<void> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return;

  const event = buildEvent(input);

  /*
   * Последняя проверка перед отправкой. Пояс поверх подтяжек: сборка события
   * персональных данных не берёт, но если однажды кто-то добавит поле, мы
   * не хотим узнать об этом из чужой панели.
   */
  const leak = containsPersonalData(event);
  if (leak) {
    log.error("sentry.blocked", { field: leak, hint: "событие содержит персональные данные" });
    return;
  }

  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    const endpoint = `${url.protocol}//${url.host}/api/${projectId}/store/`;
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${url.username}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    // сборщик ошибок не должен ронять приложение — молча пишем в свой лог
    log.warn("sentry.send_failed", { error: String(err) });
  }
}
