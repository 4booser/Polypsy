import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { standDatabaseUrl } from "./stand";

/**
 * Готовит стенд: создаёт базу `quizzy_e2e`, если её нет, и пересоздаёт схему
 * с посевом. Отдельная база, а не отдельная схема, — чтобы `drop schema
 * public cascade` внутри db:reset не мог задеть ничего чужого.
 */
export default async function globalSetup() {
  const url = new URL(standDatabaseUrl());
  const dbName = url.pathname.slice(1);

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";
  const admin = postgres(adminUrl.toString(), { max: 1 });
  const [exists] = await admin`select 1 from pg_database where datname = ${dbName}`;
  if (!exists) await admin.unsafe(`create database "${dbName}"`);
  await admin.end();

  const reset = spawnSync("bun", ["run", "--cwd", "apps/api", "db:reset"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url.toString(), NODE_ENV: "development" },
  });
  if (reset.status !== 0) throw new Error("не удалось подготовить базу для смоука");
}
