import { eq } from "drizzle-orm";
import { baseDb } from "./db";
import { systemContext } from "./db/context";
import { noteSearch, patientNotes } from "./db/schema";
import { decryptField } from "./lib/crypto";
import { indexOf } from "./lib/searchIndex";
import { log } from "./lib/log";

/**
 * Пересборка слепого индекса записей.
 *
 * Нужна дважды: при первом развёртывании поиска (записи, сделанные раньше, в
 * индексе отсутствуют, и без этого прохода поиск честно не находит ничего) и
 * после смены секрета — отпечатки считаются на нём, и со старым ключом индекс
 * становится набором чужих строк.
 *
 * Отдельной командой, а не при старте приложения: на десятках тысяч записей
 * это минуты работы и расшифровка всего массива, и делать такое неявно при
 * каждом перезапуске нельзя.
 */
async function reindex(): Promise<void> {
  const rows = await baseDb.select().from(patientNotes);
  log.info("reindex.start", { notes: rows.length });

  let indexed = 0;
  let skipped = 0;

  for (const row of rows) {
    const text = decryptField(row.text);
    if (!text) {
      /*
       * Запись не расшифровалась — скорее всего зашифрована ключом, которого
       * сейчас нет. Пропускаем и считаем: молча оставить её без индекса
       * значит потом гадать, почему поиск её не находит.
       */
      skipped++;
      continue;
    }

    await baseDb.delete(noteSearch).where(eq(noteSearch.noteId, row.id));
    const values = indexOf(text).map((fp) => ({
      noteId: row.id,
      kind: "note",
      userId: row.userId,
      fp,
    }));
    if (values.length) await baseDb.insert(noteSearch).values(values).onConflictDoNothing();
    indexed++;
  }

  log.info("reindex.done", { indexed, skipped });
  console.log(`Проиндексировано записей: ${indexed}${skipped ? `, пропущено: ${skipped}` : ""}`);
}

await systemContext(baseDb, reindex);
process.exit(0);
