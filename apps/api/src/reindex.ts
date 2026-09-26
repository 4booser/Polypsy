import { baseDb } from "./db";
import { systemContext } from "./db/context";
import { reindexNotes } from "./lib/noteReindex";

/**
 * Пересборка слепого индекса записей — командой.
 *
 *   bun apps/api/src/reindex.ts
 *
 * Сама работа и её обоснование — в lib/noteReindex.ts: тот же проход
 * запускается кнопкой «Запустити зараз» в техпанели, и две копии одного
 * прохода разошлись бы на первой же правке индекса.
 */
const { indexed, skipped } = await systemContext(baseDb, reindexNotes);
console.log(`Проиндексировано записей: ${indexed}${skipped ? `, пропущено: ${skipped}` : ""}`);
process.exit(0);
