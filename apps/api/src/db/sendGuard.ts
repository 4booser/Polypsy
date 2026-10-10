/**
 * Запрос, которого драйвер всё равно не отправит, — отказ до драйвера.
 *
 * У протокола PostgreSQL на число параметров два байта, и postgres.js
 * проверяет потолок (65 533) не при вызове, а уже на соединении, когда
 * собирает сообщение. Если на этом соединении в тот момент идёт другой
 * запрос — а в транзакции запроса так всякий раз, когда обработчик пускает
 * запросы через Promise.all, — отказ достаётся НЕ ТОМУ запросу: драйвер
 * отклоняет тот, что в работе, а несобранный оставляет в очереди ждущих
 * ответа, хотя на сервер он не ушёл. Дальше каждый ответ сервера
 * приписывается предыдущему запросу, а последнему — ROLLBACK транзакции —
 * не достаётся никакого. Транзакция не кончается никогда, обработчик не
 * отвечает, соединение в пул не возвращается и висит на сервере
 * «idle | rollback». Так вставала аналитика методики с 69 тыс. прохождений
 * (#183): десять нажатий — пул пуст, API молчит; соседние запросы того же
 * соединения при этом получали чужие ответы.
 *
 * Поэтому потолок проверяется здесь, на шве drizzle — том же, что у
 * распаковки ошибок (./errors.ts) и счёта SQL (lib/opsSql.ts): через
 * PostgresJsPreparedQuery.execute/all идёт и построитель, и
 * db.execute(sql`…`), и всё это внутри транзакций, любым пулом. Запрос
 * отклоняется, не дойдя до соединения, транзакция откатывается обычным
 * порядком, обработчик отвечает 500 сразу. Сами списки id в маршрутах
 * передаются одним параметром (./ids.ts) — это сторож на будущее, а не
 * способ обработать большой список.
 *
 * Отвергнуто: чинить порядок в обёртке транзакции запроса — зависает
 * ROLLBACK внутри драйвера, и снаружи ни дождаться его, ни отменить нельзя;
 * таймаут оставил бы соединение сломанным. Отвергнут и Proxy над клиентом
 * postgres.js (begin, savepoint) — по той же причине, что в lib/opsSql.ts.
 */
import { PostgresJsPreparedQuery } from "drizzle-orm/postgres-js/session";

/** Сколько параметров postgres.js ещё отправляет в одном запросе */
export const MAX_QUERY_PARAMETERS = 65_533;

type Run = (this: { params: unknown[]; queryString: string }, ...args: unknown[]) => Promise<unknown>;

let installed = false;

/** Поставить проверку на PostgresJsPreparedQuery.execute/all. Идемпотентно. */
export function installSendGuard(): void {
  if (installed) return;
  installed = true;
  const proto = PostgresJsPreparedQuery.prototype as unknown as Record<"execute" | "all", Run>;
  for (const name of ["execute", "all"] as const) {
    const original = proto[name];
    proto[name] = function (this: { params: unknown[]; queryString: string }, ...args: unknown[]) {
      const count = this.params?.length ?? 0;
      if (count > MAX_QUERY_PARAMETERS) {
        const error = Object.assign(
          new Error(`MAX_PARAMETERS_EXCEEDED: ${count} parameters, the driver sends at most ${MAX_QUERY_PARAMETERS}`),
          { code: "MAX_PARAMETERS_EXCEEDED" },
        );
        // текст запроса — как у ошибок драйвера (./errors.ts): рядом, а не в сообщении
        Object.defineProperty(error, "query", { value: this.queryString, enumerable: false, writable: true });
        return Promise.reject(error);
      }
      return original.apply(this, args);
    };
  }
}
