/**
 * Наполнить экземпляр вымышленными людьми и их историей лечения.
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
import { DemoFillRefused, DemoPurgeRefused, fillDemoData, purgeDemoData } from "./lib/demoFill";
import { ARCHETYPE_TITLES } from "./lib/demoStories";
import { purgeDemoGroupsRules, seedDemoGroupsRules } from "./seed/demoGroupsRules";

const arg = process.argv[2] ?? "60";

/*
 * Отказ — сообщением, а не трассой стека: он говорит, что сделать, и
 * транзакция системного контекста уже откатила всё сделанное.
 */
async function refused(e: unknown): Promise<never> {
  if (!(e instanceof DemoPurgeRefused) && !(e instanceof DemoFillRefused)) throw e;
  console.error(`  ✗ ${e.message}`);
  await client.end();
  process.exit(1);
}

if (arg === "purge") {
  const removed = await systemContext(baseDb, () => purgeDemoData()).catch(refused);
  /*
   * Группы и правила посева — такие же вымышленные данные, как люди, и
   * убираются той же командой. Собранные из вымышленных, после их удаления
   * они остались бы строками с пустым составом: «убрать всех вымышленных»
   * обязано убирать и их, а demo-fill заводит их заново.
   *
   * Строго ПОСЛЕ людей, а не до: этот порядок ежедневно проверяет, что
   * владелец групп — настоящий сотрудник. Владей ими вымышленный
   * demo-specialist, RESTRICT на patient_groups.owner_id уронил бы уборку
   * людей выше, и отказ пришёл бы из базы, а не из догадки.
   */
  const cleared = await systemContext(baseDb, () => purgeDemoGroupsRules());
  console.log(`  ✓ убрано вымышленных: ${removed}`);
  console.log(`  ✓ групп и правил:     ${cleared.groups} и ${cleared.rules}`);
} else {
  const count = Number(arg);
  if (!Number.isFinite(count) || count < 1 || count > 500) {
    console.error("Сколько человек завести: число от 1 до 500");
    await client.end();
    process.exit(1);
  }
  const report = await systemContext(baseDb, () => fillDemoData(count)).catch(refused);
  console.log(`  ✓ заведено людей:    ${report.created} (уже были: ${report.existing})`);
  console.log(`  ✓ прохождений:       ${report.responses}`);
  console.log(`  ✓ обращений:         ${report.episodes}`);
  console.log(`  ✓ приёмов:           ${report.appointments}`);
  console.log(`  ✓ записей приёма:    ${report.notes}`);
  console.log(`  ✓ заключений:        ${report.conclusions}`);
  console.log(`  ✓ планов безопасности: ${report.safetyPlans}`);
  console.log(`  ✓ случаев риска:     ${report.openCases} открыто, ${report.closedCases} разобрано`);
  console.log(`  ✓ наборов назначено: ${report.assignments}`);
  console.log(`  ✓ направлений:       ${report.referrals}`);
  console.log(`  ✓ переписок:         ${report.threads}`);
  console.log(`  ✓ на учёте:          ${report.dispensary}`);
  console.log(`  ✓ должностей:        ${report.ladder}`);
  console.log(`  ✓ приглашений:       ${report.invites}`);
  for (const [key, n] of Object.entries(report.archetypes)) {
    console.log(`      ${String(n).padStart(3)} — ${ARCHETYPE_TITLES[key as keyof typeof ARCHETYPE_TITLES]}`);
  }
  /*
   * Группы пациентов и правила поддержки решений — из посева, а не из
   * наполнения: они собраны на людях посева и demo-purge не задевают. Здесь
   * они потому, что посев прода не пересоздаётся, и demo-fill — единственное
   * действие, которое дополняет живую базу демонстрационными данными. Тот же
   * системный контекст: под боевой ролью БД политики строк без него не
   * пустят ни в patient_groups, ни в decision_rules.
   */
  await systemContext(baseDb, () => seedDemoGroupsRules());
}

await client.end();
