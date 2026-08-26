import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "../env";
import * as schema from "./schema";

/**
 * Пул соединений к PostgreSQL.
 *
 * max держим небольшим: приложение живёт в одном процессе Bun, а каждое
 * соединение — это отдельный бэкенд-процесс на стороне сервера БД.
 */
const client = postgres(env.databaseUrl, {
  max: 10,
  idle_timeout: 20,
  // имена в схеме уже в snake_case, автопреобразование только запутает
  transform: undefined,
});

export const db = drizzle(client, { schema });
export { client, schema };
