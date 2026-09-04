/**
 * Сверка хеш-цепочки журнала.
 *
 *   bun apps/api/src/auditReport.ts
 *
 * Головной хэш стоит время от времени записывать вовне — распечатать,
 * отправить: тогда подделка даже всей таблицы целиком обнаружима сверкой с
 * внешней копией. Проверка изнутри доказывает лишь связность.
 */
import { client } from "./db";
import { verifyChain } from "./lib/auditVerify";

const report = await verifyChain();
if (!report.ok) {
  console.error(`  ✗ ЦЕПОЧКА НАРУШЕНА на записи ${report.brokenAtSeq ?? "?"}`);
  console.error(`    проверено: ${report.checked}`);
  await client.end();
  process.exit(1);
}
console.log(`  ✓ цепочка цела, записей: ${report.checked}`);
console.log(`    головной хэш: ${report.headHash ?? "—"}`);
await client.end();
