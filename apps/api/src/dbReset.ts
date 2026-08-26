/**
 * Полный сброс базы: дроп схемы → миграции → посев. ТОЛЬКО для разработки.
 * В production скрипт отказывается работать — сброс живой клинической базы
 * не должен быть возможен одной командой ни при каких обстоятельствах.
 */
import { env } from "./env";

if (env.isProduction) {
  console.error("db:reset запрещён в production");
  process.exit(1);
}

import postgres from "postgres";

const sql = postgres(env.databaseUrl, { max: 1 });
await sql`drop schema if exists public cascade`;
await sql`create schema public`;
await sql`drop schema if exists drizzle cascade`;
await sql.end();
console.log("схема сброшена, применяю миграции…");

await import("./migrate");
await import("./seed");
