import { desc, isNull } from "drizzle-orm";
import { db } from "../db";
import { crisisPeriods } from "../db/schema";

/**
 * Кризисный режим учреждения — массовое поступление.
 *
 * Что он делает, перечислено явно и коротко, потому что режим, про который
 * непонятно, что он меняет, страшнее любого потока пациентов:
 *
 *  1. Плановые расписания повторных замеров не запускаются. В массовое
 *     поступление очередь работы должна наполняться поступившими, а не
 *     плановыми напоминаниями трёхмесячной давности.
 *  2. Очередь работы сортируется строго по тяжести: рутина уходит вниз.
 *  3. В консоли висит полоса с причиной и тем, кто включил.
 *
 * Всё остальное продолжает работать как обычно. Отключать проверки прав,
 * согласия или журнал «потому что кризис» нельзя — именно в такие дни разбор
 * потом и понадобится.
 */

export interface CrisisState {
  active: boolean;
  reason: string | null;
  startedAt: string | null;
  startedBy: string | null;
}

export async function currentCrisis(): Promise<CrisisState> {
  const [row] = await db
    .select()
    .from(crisisPeriods)
    .where(isNull(crisisPeriods.endedAt))
    .orderBy(desc(crisisPeriods.startedAt))
    .limit(1);

  if (!row) return { active: false, reason: null, startedAt: null, startedBy: null };
  return {
    active: true,
    reason: row.reason,
    startedAt: row.startedAt,
    startedBy: row.startedBy,
  };
}
