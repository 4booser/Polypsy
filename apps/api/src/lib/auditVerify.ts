import { asc, isNotNull } from "drizzle-orm";
import { db } from "../db";
import { auditLog } from "../db/schema";
import { chainHash } from "./audit";

export interface ChainReport {
  ok: boolean;
  checked: number;
  /** Записи до внедрения цепочки — без хэшей, их целостность не доказуема */
  legacy: number;
  brokenAtSeq: number | null;
  headSeq: number | null;
  headHash: string | null;
}

/**
 * Проверка целостности цепочки журнала.
 *
 * Идёт по seq по порядку и пересчитывает каждый хэш. Любая правка задним
 * числом — изменение поля, подмена details, удаление строки — рвёт цепочку на
 * первой затронутой записи, и отчёт называет её номер.
 */
export async function verifyChain(): Promise<ChainReport> {
  const legacyRows = await db.$count(auditLog);
  const rows = await db
    .select()
    .from(auditLog)
    .where(isNotNull(auditLog.seq))
    .orderBy(asc(auditLog.seq));

  let prevHash: string | null = null;
  let prevSeq = 0;
  for (const row of rows) {
    if (row.seq !== prevSeq + 1) {
      return { ok: false, checked: prevSeq, legacy: legacyRows - rows.length, brokenAtSeq: row.seq, headSeq: null, headHash: null };
    }
    const expected = chainHash(prevHash, {
      id: row.id,
      at: row.at,
      actorId: row.actorId,
      actorEmail: row.actorEmail,
      actorRole: row.actorRole,
      action: row.action,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      subjectUserId: row.subjectUserId,
      outcome: row.outcome,
      ip: row.ip,
      userAgent: row.userAgent,
      details: row.details,
    });
    if (expected !== row.entryHash || row.prevHash !== prevHash) {
      return { ok: false, checked: prevSeq, legacy: legacyRows - rows.length, brokenAtSeq: row.seq, headSeq: null, headHash: null };
    }
    prevHash = row.entryHash;
    prevSeq = row.seq!;
  }

  return {
    ok: true,
    checked: rows.length,
    legacy: legacyRows - rows.length,
    brokenAtSeq: null,
    headSeq: prevSeq || null,
    headHash: prevHash,
  };
}
