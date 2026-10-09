/**
 * Применяет SQL-миграции из ./drizzle к базе и сверяет журнал с базой.
 * Запуск: bun run db:migrate. Новые миграции пишутся руками — docs/RUNBOOK.md, «Новая миграция»
 *
 * Сверка — в db/migrations.ts (runMigrations): миграция из журнала, которой
 * база не получила, — это выход с кодом 1 и её имя, а не «применены».
 * Этим скриптом схему приводят проверка копии (scripts/verify-backup.sh) и
 * обновление экземпляров (scripts/upgrade-instances.sh); на выкатке то же
 * делает provision.ts.
 */
import { client, db } from "./db";
import { MigrationLedgerError, runMigrations } from "./db/migrations";

try {
  await runMigrations(db);
  console.log("Миграции применены.");
} catch (error) {
  if (!(error instanceof MigrationLedgerError)) throw error;
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
