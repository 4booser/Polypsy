/**
 * Обрыв клиента отменяет запросы его транзакции к базе (#186).
 *
 * Какие запросы отменять, знает транзакция запроса (RequestAbort в
 * ./context.ts); здесь — как их увидеть. Шов тот же, что у распаковки
 * ошибок (./errors.ts), сторожа параметров (./sendGuard.ts) и счёта SQL
 * (lib/opsSql.ts): PostgresJsPreparedQuery.execute/all — через него идёт и
 * построитель, и db.execute(sql`…`), и запросы внутри транзакций и точек
 * сохранения. Сам запрос postgres.js (у него есть отмена) рождается внутри
 * drizzle вызовом client.unsafe; поэтому на время вызова drizzle получает
 * клиент, который запоминает рождённый запрос за обрывом текущего запроса
 * и забывает его, когда тот ответил.
 *
 * После обрыва новый запрос не отправляется вовсе — отказ сразу: обработчик,
 * считавший в памяти, пока шла отмена, иначе пошёл бы в базу снова, и
 * соединение жило бы до конца его работы.
 *
 * Вне транзакции запроса (фоновые задачи, публичные конвейеры, сюита) —
 * ровно прежний путь, без обёрток.
 */
import { PostgresJsPreparedQuery } from "drizzle-orm/postgres-js/session";
import { type CancellableQuery, cancelQuery, currentRequestAbort } from "./context";

type Unsafe = (...args: unknown[]) => CancellableQuery;
interface Prepared {
  client: { unsafe: Unsafe };
}
type Run = (this: Prepared, ...args: unknown[]) => Promise<unknown>;

/** Отказ запроса, клиент которого ушёл: код — как у отмены в Postgres */
export function clientGone(): Error {
  return Object.assign(new Error("canceling statement: the client closed the request"), { code: "57014" });
}

let installed = false;

/** Поставить отмену по обрыву на PostgresJsPreparedQuery.execute/all. Идемпотентно. */
export function installCancelOnAbort(): void {
  if (installed) return;
  installed = true;
  const proto = PostgresJsPreparedQuery.prototype as unknown as Record<"execute" | "all", Run>;
  for (const name of ["execute", "all"] as const) {
    const original = proto[name];
    proto[name] = function (this: Prepared, ...args: unknown[]) {
      const abort = currentRequestAbort();
      if (!abort) return original.apply(this, args);
      if (abort.aborted) return Promise.reject(clientGone());
      const born: CancellableQuery[] = [];
      const client = this.client;
      const tracked = new Proxy(client, {
        get(target, prop, receiver) {
          if (prop !== "unsafe") return Reflect.get(target, prop, receiver);
          return (...a: unknown[]) => {
            const query = target.unsafe(...a);
            born.push(query);
            abort.inflight.add(query);
            // обрыв мог прийти, пока drizzle собирал запрос
            if (abort.aborted) cancelQuery(query);
            return query;
          };
        },
      });
      /* наследник запроса drizzle: всё его, кроме клиента */
      const view = Object.create(this) as Prepared;
      view.client = tracked;
      return original.apply(view, args).finally(() => {
        for (const query of born) abort.inflight.delete(query);
      });
    };
  }
}
