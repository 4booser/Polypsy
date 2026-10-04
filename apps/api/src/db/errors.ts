/**
 * Ошибки базы — такими, какими их отдаёт драйвер.
 *
 * drizzle с 0.44 оборачивает каждую ошибку драйвера в DrizzleQueryError:
 * сообщение — «Failed query: <SQL>\nparams: <значения>», сама ошибка
 * Postgres — в cause. Для нас это плохо дважды.
 *
 * Во-первых, в сообщении лежат значения параметров — ФИО, телефоны, ответы
 * на пункты, — а сообщение ошибки уходит в лог (String(error) в полусотне
 * мест), в группы техпанели (lib/opsBuffer.ts) и в сборщик ошибок
 * (lib/errorReport.ts); каждый такой выход построен на том, что текст
 * ошибки персональных данных не несёт. Группировка по сообщению при этом
 * распадается: каждый набор параметров — новая группа.
 *
 * Во-вторых, причина отказа из сообщения пропадает: ни кода (23505, 42501,
 * 22xxx), ни ограничения, ни текста Postgres, — всё это остаётся в cause, и
 * код, который различает отказы по коду (isUniqueViolation, stateOfError,
 * isDataError) или по тексту (тесты политик строк), перестаёт их видеть.
 *
 * Поэтому обёртка снимается на том же шве, где считается SQL (lib/opsSql.ts):
 * PostgresJsPreparedQuery.execute/all — единственная точка, через которую
 * проходят построитель, db.execute(sql`…`), relational queries и всё то же
 * внутри транзакций. Наружу летит ошибка драйвера, как в drizzle ≤0.43; текст
 * запроса — параметризованный, без значений — остаётся на ней полем query,
 * чтобы разбор знал, какой запрос упал (ради этого drizzle обёртку и ввёл).
 *
 * Ставится при загрузке db/index.ts — раньше первого запроса любого входа:
 * приложения, миграций, скриптов, тестов. Сторож — test/dbErrors.test.ts.
 */
import { DrizzleQueryError } from "drizzle-orm/errors";
import { PostgresJsPreparedQuery } from "drizzle-orm/postgres-js/session";

/** Ошибка драйвера с текстом упавшего запроса (без параметров) */
export interface DbError extends Error {
  code?: string;
  constraint_name?: string;
  /** Параметризованный SQL, на котором упало: $1, $2 вместо значений */
  query?: string;
}

/**
 * Снять обёртку drizzle: ошибка драйвера с текстом запроса на ней.
 * Не DrizzleQueryError и обёртка без причины — возвращается как есть.
 */
export function unwrapDbError(error: unknown): unknown {
  if (!(error instanceof DrizzleQueryError)) return error;
  const cause = error.cause;
  if (!(cause instanceof Error)) return error;
  const driverError = cause as DbError;
  if (driverError.query === undefined) {
    Object.defineProperty(driverError, "query", { value: error.query, enumerable: false, writable: true });
  }
  return driverError;
}

type Run = (...args: unknown[]) => Promise<unknown>;

let installed = false;

/** Поставить распаковку на PostgresJsPreparedQuery.execute/all. Идемпотентно. */
export function installDbErrorUnwrap(): void {
  if (installed) return;
  installed = true;
  const proto = PostgresJsPreparedQuery.prototype as unknown as Record<"execute" | "all", Run>;
  for (const name of ["execute", "all"] as const) {
    const original = proto[name];
    proto[name] = async function (this: unknown, ...args: unknown[]) {
      try {
        return await original.apply(this, args);
      } catch (error) {
        throw unwrapDbError(error);
      }
    };
  }
}
