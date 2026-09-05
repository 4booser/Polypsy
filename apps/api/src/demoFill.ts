/**
 * Наполнить экземпляр вымышленными людьми и их обследованиями.
 *
 *   bun apps/api/src/demoFill.ts 120     — завести 120 человек
 *   bun apps/api/src/demoFill.ts purge   — убрать всех вымышленных
 *
 * Запускается только руками. Наполнять живую картотеку сама система не
 * должна: то, что заводится по команде человека, он и уберёт по команде, а
 * то, что заводится само, однажды заведётся там, где не надо.
 */
import { baseDb, client } from "./db";
import { systemContext } from "./db/context";
import { fillDemoData, purgeDemoData } from "./lib/demoFill";

const arg = process.argv[2] ?? "60";

if (arg === "purge") {
  const removed = await systemContext(baseDb, () => purgeDemoData());
  console.log(`  ✓ убрано вымышленных: ${removed}`);
} else {
  const count = Number(arg);
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    console.error("Сколько человек завести: число от 1 до 500");
    await client.end();
    process.exit(1);
  }
  const report = await systemContext(baseDb, () => fillDemoData(count));
  console.log(`  ✓ заведено людей:    ${report.created} (уже были: ${report.existing})`);
  console.log(`  ✓ прохождений:       ${report.responses}`);
  console.log(`  ✓ обращений:         ${report.episodes}`);
  console.log(`  ✓ приёмов:           ${report.appointments}`);
  console.log(`  ✓ назначений:        ${report.assignments}`);
}

await client.end();
