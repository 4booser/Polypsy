/**
 * Применяет SQL-миграции из ./drizzle к базе.
 * Запуск: bun run db:migrate (после bun run db:generate)
 */
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { client, db } from "./db";

await migrate(db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
console.log("Миграции применены.");
await client.end();
