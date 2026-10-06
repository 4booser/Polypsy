import { and, desc, eq } from "drizzle-orm";
import { baseDb, db } from "../db";
import { systemContext } from "../db/context";
import { noteSearch, patientNotes, securityJobs } from "../db/schema";
import { auditSystem } from "./audit";
import { decryptField } from "./crypto";
import { JobLocked, withJobLock } from "./jobLock";
import { log } from "./log";
import { indexOf, searchSecretMark } from "./searchIndex";

/**
 * Пересборка слепого индекса записей.
 *
 * Нужна дважды: при первом развёртывании поиска (записи, сделанные раньше, в
 * индексе отсутствуют, и без этого прохода поиск честно не находит ничего) и
 * после смены секрета — отпечатки считаются на нём, и со старым ключом индекс
 * становится набором чужих строк.
 *
 * Не при каждом старте приложения: на десятках тысяч записей это минуты
 * работы и расшифровка всего массива. Запускается командой
 * (apps/api/src/reindex.ts), кнопкой «Запустити зараз» техпанели
 * (lib/opsManual.ts) — одна функция на оба пути, иначе две копии разошлись
 * бы на первой же правке индекса, — и при старте ТОЛЬКО если секрет сменился
 * (ensureSearchIndexCurrent ниже).
 *
 * Идёт внутри того контекста, что открыл вызывающий (системного): политики
 * строк закрывают записи всем, кроме их авторов.
 *
 * ═══ Проверяемый итог ═══
 *
 * Каждый проход — строка security_jobs вида search_reindex (миграция 0117):
 * на каком секрете строили (target_key — отпечаток секрета, не он сам),
 * сколько записей, сколько пропущено, когда закончили, чем. Прежде итог жил
 * только в строке консоли и логе: через неделю нельзя было ответить, на
 * каком секрете стоит индекс и пересобирали ли его после ротации.
 */
export interface ReindexResult {
  indexed: number;
  skipped: number;
  /** Отпечаток секрета, на котором построен индекс */
  secretMark: string;
  jobId: string;
}

export async function reindexNotes(): Promise<ReindexResult> {
  const secretMark = searchSecretMark();
  const rows = await db.select().from(patientNotes).orderBy(patientNotes.createdAt, patientNotes.id);
  log.info("reindex.start", { notes: rows.length, secretMark });

  const jobId = crypto.randomUUID();
  await db.insert(securityJobs).values({
    id: jobId,
    kind: "search_reindex",
    status: "running",
    targetKey: secretMark,
    total: rows.length,
  });

  let indexed = 0;
  let skipped = 0;
  try {
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

      await db.delete(noteSearch).where(eq(noteSearch.noteId, row.id));
      const values = indexOf(text).map((fp) => ({
        noteId: row.id,
        kind: "note",
        userId: row.userId,
        fp,
      }));
      if (values.length) await db.insert(noteSearch).values(values).onConflictDoNothing();
      indexed++;
      if ((indexed + skipped) % 200 === 0) {
        await db
          .update(securityJobs)
          .set({ processed: indexed, skipped, heartbeatAt: new Date().toISOString() })
          .where(eq(securityJobs.id, jobId));
      }
    }
  } catch (error) {
    const at = new Date().toISOString();
    await db
      .update(securityJobs)
      .set({ status: "failed", processed: indexed, skipped, finishedAt: at, heartbeatAt: at, error: String(error).slice(0, 500) })
      .where(eq(securityJobs.id, jobId));
    throw error;
  }

  const at = new Date().toISOString();
  await db
    .update(securityJobs)
    .set({ status: "done", processed: indexed, skipped, finishedAt: at, heartbeatAt: at })
    .where(eq(securityJobs.id, jobId));
  await auditSystem({
    action: "sec.search_reindexed",
    resourceType: "security_job",
    resourceId: jobId,
    details: { indexed, skipped, secretMark },
  });
  log.info("reindex.done", { indexed, skipped, secretMark });
  return { indexed, skipped, secretMark, jobId };
}

/**
 * На каком секрете построен индекс — по последней завершённой переиндексации.
 * null — переиндексаций не было: индекс либо пуст, либо собран до журнала
 * (на JWT_SECRET, как было до SEARCH_INDEX_SECRET).
 */
export async function indexedSecretMark(): Promise<string | null> {
  const [row] = await db
    .select({ targetKey: securityJobs.targetKey })
    .from(securityJobs)
    .where(and(eq(securityJobs.kind, "search_reindex"), eq(securityJobs.status, "done")))
    .orderBy(desc(securityJobs.finishedAt), desc(securityJobs.startedAt))
    .limit(1);
  return row?.targetKey ?? null;
}

/**
 * Индекс соответствует текущему секрету? Иначе — пересобрать.
 *
 * Зовётся при старте той реплики, где живёт планировщик (index.ts). Это и
 * есть переход без потери поиска: выкатка заводит SEARCH_INDEX_SECRET на
 * сервере, где индекс построен на JWT_SECRET; первый запуск видит, что
 * отпечаток секрета в журнале переиндексаций другой (или журнала нет), и
 * пересобирает индекс сам — записи лежат шифрованными и расшифровываются.
 * То же при любой следующей смене секрета.
 *
 * Почему пересобрать, а не читать по обоим секретам «пока не
 * переиндексировано». Индекс не хранит, на каком секрете посчитана строка,
 * и чтобы знать, когда двойное чтение можно снять, нужен ровно тот же журнал
 * — то есть двойное чтение не избавляет от переиндексации, а добавляет к ней
 * второй список отпечатков в каждом запросе и ещё одну зависимость от
 * JWT_SECRET, который к тому времени мог быть сменён уже сам. Плата за
 * выбранное: от старта до конца пересборки поиск по ещё не прошедшим
 * записям пуст — минуты на большой базе, один раз.
 *
 * Замок в базе (withJobLock): две реплики, стартовавшие разом, не
 * пересоберут индекс дважды; проигравшая просто выходит. Пустой индекс
 * (записей нет) отмечается тоже — чтобы следующий старт не проверял заново.
 */
export async function ensureSearchIndexCurrent(): Promise<"current" | "reindexed" | "busy"> {
  const current = searchSecretMark();
  const indexed = await systemContext(baseDb, indexedSecretMark);
  if (indexed === current) return "current";
  log.warn("search.index_stale", { indexed, current });
  try {
    await withJobLock("search.reindex", () => systemContext(baseDb, reindexNotes));
    return "reindexed";
  } catch (error) {
    if (error instanceof JobLocked) return "busy";
    throw error;
  }
}
