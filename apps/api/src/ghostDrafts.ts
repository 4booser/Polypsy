/**
 * Черновики-призраки (#197) — обзор и чистка командой.
 *
 *   bun apps/api/src/ghostDrafts.ts           сухой прогон: что найдено, ничего не меняет
 *   bun apps/api/src/ghostDrafts.ts --apply   закрыть тревоги-дубли и удалить призраков
 *
 * Что такое призрак, почему его тревоги — дубли и что именно делает --apply,
 * — в lib/ghostDrafts.ts. Призраков «на разбор» (ответы разошлись со
 * сданной попыткой, тревога без пары или тяжелее сданной) команда не
 * трогает ни в каком режиме: их показывает, решает человек.
 *
 * Повторный прогон с --apply ничего не делает: дублей после первого не
 * остаётся. Вывод — только идентификаторы, тяжесть и состояние: ни подписей
 * тревог (это текст пункта), ни ответов в журнал прогона не попадает.
 */
import { client } from "./db";
import { ghostDrafts, type Ghost } from "./lib/ghostDrafts";

const apply = process.argv.includes("--apply");
const unknown = process.argv.slice(2).filter((a) => a !== "--apply");
if (unknown.length) {
  console.error(`  ✗ неизвестные параметры: ${unknown.join(" ")} — есть только --apply`);
  process.exit(2);
}

const REASON: Record<NonNullable<Ghost["reason"]>, string> = {
  answers: "ответы расходятся со сданной попыткой — в черновик писала другая попытка?",
  unpaired: "у тревоги нет пары у сданного прохождения",
  stronger: "тревога тяжелее сигнала сданного прохождения",
};

try {
  const report = await ghostDrafts({ apply });
  const duplicates = report.ghosts.filter((g) => g.verdict === "duplicate");
  const review = report.ghosts.filter((g) => g.verdict === "review");
  console.log(`  черновиков-призраков: ${report.ghosts.length} (дубли сданной попытки: ${duplicates.length}, на разбор: ${review.length})`);
  for (const g of report.ghosts) {
    const mark = g.verdict === "duplicate" ? "дубль" : `НА РАЗБОР: ${REASON[g.reason!]}`;
    console.log(`\n  ${g.id} → сдано ${g.submittedId} [${mark}]`);
    console.log(`    начато ${g.startedAt}, сдано ${g.submittedAt ?? "—"}, черновик сохранён ${g.lastSavedAt ?? "—"}`);
    for (const a of g.alerts) {
      const pair = a.pair ? `пара ${a.pair.id} (${a.pair.severity})` : "без пары";
      console.log(`    тревога ${a.id}: ${a.severity}, ${a.acknowledged ? "разобрана" : "открыта"}, случай ${a.caseId ?? "—"}; ${pair}`);
    }
  }
  if (apply) {
    console.log(`\n  ✓ удалено призраков: ${report.removed}; тревог закрыто как дубль: ${report.closedAlerts}; опустевших случаев закрыто: ${report.closedCases}`);
    if (report.removed < duplicates.length) {
      console.log(`  · ${duplicates.length - report.removed} — изменились до записи и оставлены: повторите сухой прогон`);
    }
  } else {
    console.log(`\n  сухой прогон: ничего не изменено${duplicates.length ? ". Закрыть дубли: --apply" : ""}`);
  }
} catch (error) {
  await client.end();
  console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

await client.end();
