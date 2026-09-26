import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";
import { dbContext } from "./context";

/**
 * Пул соединений к PostgreSQL.
 *
 * max держим небольшим: приложение живёт в одном процессе Bun, а каждое
 * соединение — это отдельный бэкенд-процесс на стороне сервера БД.
 *
 * Маленький пул держится на инварианте «один запрос — одна транзакция
 * запроса»: запрос, который держит своё соединение и просит второе, при
 * десяти одновременных таких же ждёт вечно — все соединения заняты первыми
 * транзакциями. Так вставал /api/ops/data с двойной авторизацией (внешний
 * разбор 2026-09-26); сторож — test/authOnce.test.ts.
 */
const client = postgres(env.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  // имена в схеме уже в snake_case, автопреобразование только запутает
  transform: undefined,
});

const baseDb = drizzle(client, { schema });

/**
 * Прокси над drizzle: если вызов идёт внутри контекста (см. ./context) —
 * уходит в транзакцию контекста, иначе в пул напрямую. Существующий код
 * продолжает писать db.select()… и не знает о подмене.
 */
export const db: typeof baseDb = new Proxy(baseDb, {
  get(target, prop, receiver) {
    // ленивый импорт разорвал бы цикл, но контекст не тянет index — можно прямо
    const store = dbContext.getStore();
    const source = (store ?? target) as typeof baseDb;
    const value = Reflect.get(source as object, prop, source as object) as unknown;
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(source) : value;
  },
});

export { baseDb, client, schema };
