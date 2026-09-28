/**
 * Миграции: применить и сверить журнал с базой.
 *
 * ═══ Почему не просто migrate() ═══
 *
 * Drizzle решает, что применять, по одному числу: берёт самую позднюю
 * запись в drizzle.__drizzle_migrations (created_at — это `when` из
 * _journal.json) и применяет всё, у чего `when` больше. Чего меньше — считает
 * применённым, не глядя. Поэтому миграция, вставшая в журнал ПЕРЕД уже
 * применёнными, на существующей базе не применяется никогда и молча:
 * мигратор выходит с кодом 0 и пишет «применены».
 *
 * Так и случилось в волне 12 (внешний разбор, 2026-09-28): 0097 и 0098
 * влились в main раньше 0096, и база, мигрированная в промежутке (8ff2014),
 * после обновления 0096 не получила — patient_notes.revision и
 * audit_log.hash_version не было, запись заметки отвечала 500, журнал
 * действий молча переставал писаться. На чистой базе всё было в порядке,
 * поэтому ни одна проверка этого не видела. Прод не задет — 0096–0098 ушли
 * одним выпуском, — но история main показывает ещё девять таких же вливаний
 * не по порядку (0090, 0093, 0094, 0097, 0101, 0103–0106), и каждое могло
 * так же молча обойти базу разработки или стенда.
 *
 * Поэтому после migrate() каждая запись журнала сверяется с базой: её хэш
 * должен лежать в drizzle.__drizzle_migrations. Не лежит — выкатка встаёт с
 * названием пропущенной миграции, а не запускает код поверх схемы, которой
 * он не ждёт.
 *
 * ═══ Одна функция на все входы ═══
 *
 * Схему приводят четыре входа: migrate.ts (db:migrate, проверка копии в
 * verify-backup.sh, обновление экземпляров), provision.ts (контейнер
 * provision на каждой выкатке — api не стартует, пока он не завершился
 * успешно), install.ts (установка экземпляра) и обвязка тестов. Сверка,
 * написанная в одном из них, обходилась бы остальными — поэтому все они
 * зовут runMigrations, а прямой вызов migrate() из drizzle держит сторож
 * (test/migrationJournal.test.ts).
 *
 * ═══ Хэш — ровно как у drizzle ═══
 *
 * Хэши берутся из readMigrationFiles самого drizzle: sha256 текста файла
 * целиком, с комментариями. Своя копия расчёта однажды разошлась бы с ним
 * (другая кодировка, обрезанный перевод строки) и объявила бы пропущенным
 * то, что применено, — то есть уронила бы исправную базу.
 *
 * ═══ Правленный после применения файл — предупреждение, не отказ ═══
 *
 * Бывает, что файл миграции поправили уже после того, как он где-то
 * применился (0071_staff_roles правили в тот же день, и база разработки
 * `quizzy` помнит прежний текст). Хэш тогда другой, но запись с тем же
 * `when` в базе есть: drizzle пишет created_at = when той самой записи
 * журнала, а `when` уникальны (проверяет тот же сторож). Такая база
 * миграцию получила — в прежней редакции; ронять её значило бы ронять
 * исправную базу. Это печатается предупреждением. Выпущенные миграции
 * неизменны — это сторож сверяет с последним тегом выпуска, — так что на
 * рабочей базе предупреждения быть не должно.
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";

/** Каталог миграций приложения */
export const MIGRATIONS_FOLDER = new URL("../../drizzle", import.meta.url).pathname;

/** Запись журнала вместе с хэшем файла, как его запишет drizzle */
export interface JournalEntry {
  idx: number;
  tag: string;
  when: number;
  hash: string;
}

/** Журнал в его порядке; хэши — из readMigrationFiles самого drizzle */
export function journalEntries(folder: string = MIGRATIONS_FOLDER): JournalEntry[] {
  const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const files = readMigrationFiles({ migrationsFolder: folder });
  return journal.entries.map((entry, i) => {
    const file = files[i];
    // readMigrationFiles обходит тот же journal.entries по порядку — это страховка, а не допущение
    if (!file || file.folderMillis !== entry.when) {
      throw new Error(`журнал миграций прочитан не так, как его читает drizzle: запись ${entry.tag}`);
    }
    return { idx: entry.idx, tag: entry.tag, when: entry.when, hash: file.hash };
  });
}

/** Итог сверки журнала с базой */
export interface LedgerCheck {
  /** Записи журнала, которых база не получила: ни хэша, ни времени в drizzle.__drizzle_migrations */
  missing: JournalEntry[];
  /** Получила в прежней редакции: время то же, хэш другой (файл правили после применения) */
  edited: JournalEntry[];
}

/** Сверить каждую запись журнала с drizzle.__drizzle_migrations */
export async function checkLedger<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  folder: string = MIGRATIONS_FOLDER,
): Promise<LedgerCheck> {
  const rows = (await db.execute(
    sql`select hash, created_at::text as created_at from drizzle.__drizzle_migrations`,
  )) as unknown as { hash: string; created_at: string | null }[];
  const hashes = new Set(rows.map((r) => r.hash));
  const whens = new Set(rows.map((r) => Number(r.created_at)));
  const missing: JournalEntry[] = [];
  const edited: JournalEntry[] = [];
  for (const entry of journalEntries(folder)) {
    if (hashes.has(entry.hash)) continue;
    if (whens.has(entry.when)) edited.push(entry);
    else missing.push(entry);
  }
  return { missing, edited };
}

/** Журнал разошёлся с базой: миграция из журнала в базе не применена */
export class MigrationLedgerError extends Error {
  constructor(readonly check: LedgerCheck) {
    super(
      [
        `Журнал миграций разошёлся с базой: не применены ${check.missing.length} из журнала —`,
        ...check.missing.map((e) => `  ${e.tag} (when ${e.when})`),
        "",
        "Drizzle применяет только миграции новее последней применённой, поэтому",
        "миграция, вставшая в журнал перед уже применёнными, пропускается молча и",
        "сама не догонится. Остальные миграции применены; код, который ждёт",
        "пропущенную схему, на этой базе запускать нельзя.",
        "",
        "Рабочая база: завершающая миграция восстановления, которая идемпотентно",
        "повторяет пропущенную и отмечает её в drizzle.__drizzle_migrations",
        "(образец — 0112_restore_and_followups.sql).",
        "База разработки или стенда: пересоздать её либо применить пропущенный",
        "файл вручную (psql -f apps/api/drizzle/<имя>.sql) и отметить его хэш",
        "в drizzle.__drizzle_migrations.",
      ].join("\n"),
    );
    this.name = "MigrationLedgerError";
  }
}

/**
 * Применить миграции и сверить журнал.
 *
 * Бросает MigrationLedgerError, если после migrate() какая-то запись журнала
 * в базе не применена. Файлы, поправленные после применения, — предупреждение
 * в журнал процесса: база их получила, пусть и в прежней редакции.
 */
export async function runMigrations<TSchema extends Record<string, unknown>>(
  db: PostgresJsDatabase<TSchema>,
  folder: string = MIGRATIONS_FOLDER,
): Promise<LedgerCheck> {
  await migrate(db, { migrationsFolder: folder });
  const check = await checkLedger(db, folder);
  if (check.missing.length) throw new MigrationLedgerError(check);
  if (check.edited.length) {
    console.warn(
      [
        "Миграции применены раньше в другой редакции (время журнала то же, хэш текста другой):",
        ...check.edited.map((e) => `  ${e.tag}`),
        "Файл правили после применения; база проведена по прежнему тексту.",
      ].join("\n"),
    );
  }
  return check;
}
