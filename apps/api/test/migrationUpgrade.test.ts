import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { checkLedger, journalEntries, MIGRATIONS_FOLDER, MigrationLedgerError, runMigrations } from "../src/db/migrations";
import { ADMIN_DATABASE_URL, TEST_DATABASE_NAME } from "./preload";

/**
 * Обновление со старого состояния: база, которой не досталась средняя
 * миграция, после migrate либо восстановлена, либо migrate падает — но не
 * молчит.
 *
 * Проверка чистой установки (вся сюита мигрирует пустую базу) этого не
 * видит по устройству: на пустой базе применяется всё. Воспроизведение
 * ревьюера — база, мигрированная на 8ff2014 (журнал до 0098 без 0096), после
 * штатного обновления осталась без patient_notes.revision и
 * audit_log.hash_version, а мигратор вышел с кодом 0 (внешний разбор,
 * 2026-09-28). Здесь то же состояние собирается журналом-подмножеством, и
 * обновление идёт настоящим входом — `bun src/migrate.ts`, тем же, что на
 * проверке копии и обновлении экземпляров.
 *
 * Базы — свои, одноразовые, с именем от тестовой (`<тестовая>_up_…`), и
 * удаляются в afterAll.
 */

const API = new URL("..", import.meta.url).pathname;
const entries = journalEntries();
const tagged = (tag: string) => entries.find((e) => e.tag === tag)!;

const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
const created: string[] = [];
const opened: postgres.Sql[] = [];
const folders: string[] = [];

afterAll(async () => {
  for (const c of opened) await c.end();
  for (const name of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
}, 60_000);

async function freshDatabase(label: string) {
  const name = `${TEST_DATABASE_NAME}_up_${label}_${crypto.randomUUID().slice(0, 8)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created.push(name);
  const url = new URL(ADMIN_DATABASE_URL);
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  opened.push(sql);
  return { url: url.toString(), sql, db: drizzle(sql) };
}

/** Каталог миграций, в журнале которого только выбранные записи — «код прежней версии» */
function olderCode(keep: (tag: string, idx: number) => boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "quizzy-migrations-"));
  folders.push(dir);
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.filter((e) => keep(e.tag, e.idx));
  for (const e of kept) copyFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries: kept }, null, 2));
  return dir;
}

/** Обновление настоящим входом, как на проверке копии: bun src/migrate.ts */
async function migrateScript(url: string): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["bun", "src/migrate.ts"], {
    cwd: API,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: url,
      JWT_SECRET: process.env.JWT_SECRET ?? "",
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? "",
      SCHEDULER_ENABLED: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, output: `${out}${err}` };
}

async function columns(sql: postgres.Sql, table: string): Promise<Map<string, { nullable: string; def: string | null }>> {
  const rows = await sql<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
    select column_name, is_nullable, column_default from information_schema.columns
    where table_schema = 'public' and table_name = ${table}`;
  return new Map(rows.map((r) => [r.column_name, { nullable: r.is_nullable, def: r.column_default }]));
}

describe("обновление базы, которой не досталась средняя миграция", () => {
  test(
    "без 0096 (состояние 8ff2014): migrate восстанавливает колонки и отмечает 0096 в журнале",
    async () => {
      const { url, sql, db } = await freshDatabase("0096");
      // прежний код: журнал до 0098 без 0096 — ровно то, что было в main на 8ff2014
      await runMigrations(db, olderCode((tag, idx) => idx <= 98 && tag !== "0096_integrity"));
      expect((await columns(sql, "audit_log")).has("hash_version")).toBe(false);
      expect((await columns(sql, "patient_notes")).has("revision")).toBe(false);
      // строка, записанная прежним кодом: после восстановления у неё версия канонизации 1
      await sql`insert into audit_log (id, action) values ('pre-0096', 'test.pre')`;

      const run = await migrateScript(url);
      expect(run.code, run.output.slice(-1500)).toBe(0);

      for (const [table, column] of [
        ["conclusions", "revision"],
        ["patient_notes", "revision"],
        ["audit_log", "hash_version"],
      ] as const) {
        const col = (await columns(sql, table)).get(column);
        expect(col, `${table}.${column}`).toEqual({ nullable: "NO", def: "1" });
      }
      const [row] = await sql<{ hash_version: number }[]>`select hash_version from audit_log where id = 'pre-0096'`;
      expect(row?.hash_version).toBe(1);

      const ledger = await checkLedger(db);
      expect(ledger).toEqual({ missing: [], edited: [] });
      const [mark] = await sql<{ n: number }[]>`
        select count(*)::int n from drizzle.__drizzle_migrations
        where hash = ${tagged("0096_integrity").hash} and created_at = ${tagged("0096_integrity").when}`;
      expect(mark?.n).toBe(1);
    },
    120_000,
  );

  test(
    "без средней миграции, которую никто не восстанавливает: migrate падает с её именем, а не молчит",
    async () => {
      const { url, sql, db } = await freshDatabase("0104");
      await runMigrations(db, olderCode((tag, idx) => idx <= 107 && tag !== "0104_recording_upload_id"));

      const run = await migrateScript(url);
      expect(run.code).toBe(1);
      expect(run.output).toContain("Журнал миграций разошёлся с базой");
      expect(run.output).toContain("0104_recording_upload_id");
      expect(run.output).not.toContain("Миграции применены.");

      // остальные применены — встаёт выкатка, а не половина схемы
      const [latest] = await sql<{ n: number }[]>`
        select count(*)::int n from drizzle.__drizzle_migrations where hash = ${entries.at(-1)!.hash}`;
      expect(latest?.n).toBe(1);

      // тот же отказ у функции, которую зовут provision, install и обвязка тестов
      const error = await runMigrations(db).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationLedgerError);
      expect((error as MigrationLedgerError).check.missing.map((e) => e.tag)).toEqual(["0104_recording_upload_id"]);
    },
    120_000,
  );

  test(
    "чистая база: всё применено, 0112 на ней пустая, а файл, поправленный после применения, — предупреждение, не отказ",
    async () => {
      const { sql, db } = await freshDatabase("fresh");
      expect(await runMigrations(db)).toEqual({ missing: [], edited: [] });
      const [once] = await sql<{ n: number }[]>`
        select count(*)::int n from drizzle.__drizzle_migrations where hash = ${tagged("0096_integrity").hash}`;
      expect(once?.n, "0112 не дублирует отметку 0096").toBe(1);

      /*
       * 0071_staff_roles правили в тот же день, когда она применилась на
       * базах разработки: в журнале базы её прежний хэш, время — то же.
       * База миграцию получила — ронять её нельзя.
       */
      await sql`update drizzle.__drizzle_migrations set hash = 'прежняя-редакция'
        where created_at = ${tagged("0071_staff_roles").when}`;
      const check = await runMigrations(db);
      expect(check.missing).toEqual([]);
      expect(check.edited.map((e) => e.tag)).toEqual(["0071_staff_roles"]);
    },
    120_000,
  );
});
