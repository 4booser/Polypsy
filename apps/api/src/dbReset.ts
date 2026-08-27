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

import { spawnSync } from "node:child_process";
import postgres from "postgres";

const sql = postgres(env.databaseUrl, { max: 1 });
await sql`drop schema if exists public cascade`;
await sql`create schema public`;
await sql`drop schema if exists drizzle cascade`;
await sql.end();
console.log("схема сброшена, применяю миграции…");

/*
 * Отдельными процессами, а не импортом: migrate.ts закрывает общий пул
 * (`client.end()`), и посев в том же процессе писал бы в мёртвое соединение.
 */
for (const step of ["./migrate.ts", "./seed.ts"]) {
  const run = spawnSync("bun", [new URL(step, import.meta.url).pathname], {
    stdio: "inherit",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
