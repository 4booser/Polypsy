/** Проверка цепочки журнала из консоли: bun run audit:verify */
import { verifyChain } from "./lib/auditVerify";
import { client } from "./db";

const report = await verifyChain();
if (report.ok) {
  console.log(`Цепочка целa: ${report.checked} записей, головной хэш ${report.headHash?.slice(0, 16)}… (seq ${report.headSeq})`);
  if (report.legacy) console.log(`Записей до внедрения цепочки (без хэшей): ${report.legacy}`);
} else {
  console.error(`ЦЕПОЧКА ПОРВАНА на seq ${report.brokenAtSeq}; целых записей до разрыва: ${report.checked}`);
  process.exitCode = 1;
}
await client.end();
