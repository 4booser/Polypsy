import { and, asc, gt, isNotNull, isNull } from "drizzle-orm";
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

/*
 * Порциями по seq, а не одной выборкой всей таблицы.
 *
 * Прежде журнал читался в память целиком. Пока проверку звали руками раз в
 * квартал, это было терпимо; с проверкой раз в сутки в планировщике (техпанель,
 * раздел «Цілісність») журнал в миллионы строк означал бы ежесуточный пик
 * памяти процесса, обслуживающего приём. Порция держит в памяти две тысячи
 * строк, а цепочке нужен только хэш предыдущей.
 */
const PAGE = 2000;

/**
 * Проверка целостности цепочки журнала.
 *
 * Идёт по seq по порядку и пересчитывает каждый хэш. Любая правка задним
 * числом — изменение поля, подмена details, удаление строки — рвёт цепочку на
 * первой затронутой записи, и отчёт называет её номер.
 */
export async function verifyChain(): Promise<ChainReport> {
  const legacy = await db.$count(auditLog, isNull(auditLog.seq));

  let prevHash: string | null = null;
  let prevSeq = 0;
  let chained = 0;
  for (;;) {
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(isNotNull(auditLog.seq), gt(auditLog.seq, prevSeq)))
      .orderBy(asc(auditLog.seq))
      .limit(PAGE);

    for (const row of rows) {
      // «проверено» на разрыве — сколько записей подтверждено до него
      if (row.seq !== prevSeq + 1) {
        return { ok: false, checked: prevSeq, legacy, brokenAtSeq: row.seq, headSeq: null, headHash: null };
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
        return { ok: false, checked: prevSeq, legacy, brokenAtSeq: row.seq, headSeq: null, headHash: null };
      }
      prevHash = row.entryHash;
      prevSeq = row.seq!;
      chained++;
    }
    if (rows.length < PAGE) break;
  }

  return {
    ok: true,
    checked: chained,
    legacy,
    brokenAtSeq: null,
    headSeq: prevSeq || null,
    headHash: prevHash,
  };
}
