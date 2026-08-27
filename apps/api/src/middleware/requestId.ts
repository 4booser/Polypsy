import { createMiddleware } from "hono/factory";
import { log, withRequestId } from "../lib/log";
import { inc, observe } from "../lib/metrics";

/**
 * Сквозной идентификатор запроса.
 *
 * Берётся из заголовка, если его проставил обратный прокси, иначе
 * генерируется. Уходит в ответ, в лог, в журнал доступа и в тело ошибки —
 * чтобы пользователь мог назвать номер, а не пересказывать, что делал.
 *
 * Заголовок от клиента принимаем, но обрезаем: это удобство для сшивки
 * логов, а не данные, и позволять писать в лог произвольную длину незачем.
 */
export const requestId = createMiddleware(async (c, next) => {
  /*
   * Чужой идентификатор принимаем, но просеиваем: он уходит обратно в
   * заголовок ответа и в лог. Пропускать оттуда что угодно — это подстановка
   * в лог и в заголовок, и обе неприятны. Оставляем буквы, цифры и три
   * разделителя; всё остальное выбрасываем, а если ничего не осталось —
   * генерируем свой.
   */
  const raw = c.req.header("x-request-id") ?? "";
  const cleaned = raw.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 64);
  const id = cleaned || crypto.randomUUID();
  c.header("x-request-id", id);
  c.set("requestId", id);

  const started = Date.now();
  await withRequestId(id, () => next());

  const ms = Date.now() - started;
  const status = c.res.status;
  // медленные и неуспешные запросы — заметнее остальных
  const level = status >= 500 ? "error" : status >= 400 || ms > 2000 ? "warn" : "info";
  /*
   * Путь берём шаблоном маршрута, а не фактическим адресом: иначе каждый
   * идентификатор в пути стал бы отдельной серией метрик, и их количество
   * росло бы вместе с числом пациентов.
   */
  const route = c.req.routePath ?? "unknown";
  log[level]("request", { method: c.req.method, path: route, status, ms });

  inc("quizzy_http_requests", { method: c.req.method, route, status });
  observe("quizzy_http_duration_ms", ms, { route });
});
