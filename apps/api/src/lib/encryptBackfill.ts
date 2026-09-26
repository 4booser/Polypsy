/**
 * Бэкфилл шифрования: перешифровывает открытые значения существующих строк.
 *
 * Идемпотентен: уже шифрованные значения (префикс enc1:) не трогаются,
 * прогонять можно сколько угодно раз и порциями.
 *
 * Тело вынесено из скрипта src/encryptBackfill.ts в библиотеку, чтобы у
 * бэкфилла был тест. Скрипт заканчивается client.end() и process.exit — из
 * теста его можно было бы только запустить отдельным процессом, а тогда
 * проверялся бы не бэкфилл, а умение подготовить ему окружение.
 */
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { answers, conclusions, users } from "../db/schema";
import { activeKey, encryptField, tryDecryptField } from "./crypto";
import { encryptedColumns, recordingFiles, type EncryptedColumn } from "./keyInventory";
import { rewrapAudio } from "./recordings";

export interface BackfillCounts {
  users: number;
  answers: number;
  conclusions: number;
}

/*
 * Открытое значение отличается от шифртекста отсутствием заголовка enc1:,
 * а не видом самого значения.
 *
 * Проверять дату рождения по маске ГГГГ-ММ-ДД заманчиво, но маска отвечает
 * на другой вопрос: она говорит, похоже ли значение на дату, а не
 * зашифровано ли оно. Для ФИО и текстов ответов маски нет вовсе, и тогда у
 * одной таблицы было бы два разных правила «что считать открытым». Формат
 * шифртекста задан в lib/crypto одним местом — по нему и различаем.
 */
const plain = (v: string | null) => v !== null && v !== "" && !v.startsWith("enc1:");

/** Перешифровать всё, что лежит открытым. Возвращает, сколько строк тронуто */
export async function runEncryptBackfill(): Promise<BackfillCounts> {
  /*
   * Весь проход — в системном контексте.
   *
   * Иначе бэкфилл, запущенный ролью приложения (а именно она стоит в
   * DATABASE_URL боевой установки), не увидел бы ни строки: users, как и
   * клинические таблицы, лежит под политиками, а контекста у скрипта нет.
   * Отработал бы он при этом «успешно», отчитавшись о нуле перешифрованных
   * записей, — то есть оставил бы карты открытыми и сказал, что всё сделано.
   *
   * Заодно сюда попадает и app.maintenance: он ставится через SET LOCAL, то
   * есть действует до конца транзакции. Вне транзакции значение уходило в одно
   * случайное соединение пула, а работал бэкфилл через остальные.
   */
  return systemContext(baseDb, async () => {
    // триггер неизменяемости подписанных заключений пропускает только
    // служебную сессию — включаем режим явно, след остаётся в логах Postgres
    await db.execute(sql`select set_config('app.maintenance', '1', true)`);

    const counts: BackfillCounts = { users: 0, answers: 0, conclusions: 0 };

    for (const row of await db.select().from(users)) {
      const patch: Record<string, string | null> = {};
      if (plain(row.firstName)) patch.firstName = encryptField(row.firstName);
      if (plain(row.lastName)) patch.lastName = encryptField(row.lastName);
      if (plain(row.middleName)) patch.middleName = encryptField(row.middleName);
      /*
       * Дата рождения — то самое поле, ради которого бэкфилл придётся
       * прогнать ещё раз: до исправления регистрации она уходила в базу
       * открытой (см. routes/auth.ts). Здесь она обрабатывалась и раньше,
       * так что отдельной дозаписи не нужно — нужен повторный прогон.
       */
      if (plain(row.birthDate)) patch.birthDate = encryptField(row.birthDate);
      if (Object.keys(patch).length) {
        await db.update(users).set(patch).where(eq(users.id, row.id));
        counts.users++;
      }
    }

    for (const row of await db.select({ id: answers.id, text: answers.text }).from(answers)) {
      if (!plain(row.text)) continue;
      await db.update(answers).set({ text: encryptField(row.text) }).where(eq(answers.id, row.id));
      counts.answers++;
    }

    for (const row of await db.select({ id: conclusions.id, text: conclusions.text }).from(conclusions)) {
      if (!plain(row.text)) continue;
      await db.update(conclusions).set({ text: encryptField(row.text)! }).where(eq(conclusions.id, row.id));
      counts.conclusions++;
    }

    return counts;
  });
}

/* ═══════════ перешифровка на основной ключ (ротация) ═══════════ */

/*
 * Проход выше отвечает на вопрос «что лежит открытым» и только на него: всё
 * с заголовком enc1: он пропускает. А RUNBOOK обещал большее — «прогнать
 * db:encrypt (перешифрует старое активным ключом)», — и этого не делал
 * никто: значения на старом ключе оставались на нём сколько угодно
 * прогонов, и «когда enc1:v-старый: не останется» не наступало никогда.
 *
 * Здесь — недостающая половина: всё, что лежит не на основном ключе
 * (открытым текстом или на любом другом), переводится на основной. По
 * описи шифрованных колонок (lib/keyInventory), а не по трём таблицам:
 * заметки приёма, планы безопасности, переписка, рассылки, стенограммы и
 * телефоны шифруются тем же ключом, и ротация, забывшая их, оставила бы их
 * на ключе, который вот-вот уберут.
 *
 * Порциями и по первичному ключу: огромная таблица не держит одну
 * транзакцию на час, а оборванный проход продолжается с начала без потерь —
 * перешифрованное уже на основном ключе и в выборку не попадает.
 */

export interface RewrapBatch {
  /** Последний просмотренный первичный ключ — отсюда следующая порция */
  last: string | null;
  /** Сколько строк выбрано: меньше лимита — колонка пройдена */
  seen: number;
  rewrapped: number;
  /** Не расшифровалось: ключа нет или значение битое — не тронуто */
  skipped: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/**
 * Одна порция одной колонки. Контекст (системный, app.maintenance) задаёт
 * вызывающий: порция — единица транзакции, а не прохода.
 */
export async function rewrapBatch(col: EncryptedColumn, after: string | null, limit: number): Promise<RewrapBatch> {
  const active = activeKey();
  if (!active) throw new Error("ENCRYPTION_KEY не задан — перешифровывать не на что");
  if (!col.pk) return { last: null, seen: 0, rewrapped: 0, skipped: 0 };

  const t = sql.raw(`"${col.table}"`);
  const c = sql.raw(`"${col.column}"`);
  const pk = sql.raw(`"${col.pk}"`);
  const current = `enc1:${likeEscape(active.id)}:%`;

  const rows = await db.execute<{ id: string; v: string }>(sql`
    select ${pk}::text as id, ${c} as v
      from ${t}
     where ${c} is not null and ${c} <> '' and ${c} not like ${current}
       and (${after}::text is null or ${pk}::text > ${after}::text)
     order by ${pk}::text
     limit ${limit}
  `);

  let rewrapped = 0;
  let skipped = 0;
  let last: string | null = after;
  for (const row of rows) {
    last = String(row.id);
    const opened = tryDecryptField(String(row.v));
    if (!opened.ok) {
      skipped++;
      continue;
    }
    /*
     * Сравнение со старым значением в самом UPDATE: между выборкой и записью
     * строку мог поправить живой запрос, и его значение (уже на основном
     * ключе) затёрлось бы нашим, собранным из прежнего.
     */
    const next = encryptField(opened.plain);
    const updated = await db.execute(sql`
      update ${t} set ${c} = ${next}
       where ${pk}::text = ${row.id} and ${c} = ${row.v}
    `);
    if ((updated as unknown as { count?: number }).count !== 0) rewrapped++;
  }
  return { last, seen: rows.length, rewrapped, skipped };
}

export interface RewrapTotals {
  rewrapped: number;
  skipped: number;
  files: number;
  filesUnreadable: number;
}

/**
 * Весь проход: колонки порциями, потом файлы записей приёма. `onBatch`
 * получает прирост после каждой порции — фоновое задание техпанели пишет
 * по нему ход, скрипт db:encrypt не передаёт ничего.
 */
export async function rewrapAll(
  onBatch: (delta: { processed: number; skipped: number }) => Promise<void> = async () => {},
  batchSize = 200,
): Promise<RewrapTotals> {
  const totals: RewrapTotals = { rewrapped: 0, skipped: 0, files: 0, filesUnreadable: 0 };
  const columns = await systemContext(baseDb, () => encryptedColumns());

  for (const col of columns) {
    let after: string | null = null;
    for (;;) {
      const from: string | null = after;
      const batch: RewrapBatch = await systemContext(baseDb, async () => {
        // подписанные заключения неизменяемы для всех, кроме служебной сессии
        await db.execute(sql`select set_config('app.maintenance', '1', true)`);
        return rewrapBatch(col, from, batchSize);
      });
      totals.rewrapped += batch.rewrapped;
      totals.skipped += batch.skipped;
      await onBatch({ processed: batch.rewrapped + batch.skipped, skipped: batch.skipped });
      if (batch.seen < batchSize) break;
      after = batch.last;
    }
  }

  const { paths } = await systemContext(baseDb, () => recordingFiles());
  for (const path of paths) {
    const outcome = await rewrapAudio(path);
    if (outcome === "rewrapped") totals.files++;
    if (outcome === "unreadable") totals.filesUnreadable++;
    if (outcome === "rewrapped" || outcome === "unreadable") {
      await onBatch({ processed: 1, skipped: outcome === "unreadable" ? 1 : 0 });
    }
  }
  return totals;
}
