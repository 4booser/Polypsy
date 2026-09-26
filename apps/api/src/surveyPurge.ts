/**
 * Физическое удаление методики. Единственный способ действительно стереть
 * её из базы — и он намеренно живёт только на сервере.
 *
 * Из консоли методику можно лишь снять с использования: строка `surveys`
 * связана каскадом с прохождениями, баллами, тревогами и назначениями, и
 * настоящее удаление уносит клиническую историю живых людей. Такое решение
 * не должно приниматься нажатием кнопки в браузере.
 *
 * Сама логика — в lib/surveyPurge.ts (там же — почему так и что чинилось):
 * сводка и чистка идут под системным контекстом, случаи с сигналами других
 * методик переносятся, а не уничтожаются, журнал пишется в одной транзакции
 * с удалением.
 *
 * Запуск:
 *   bun run survey:purge <id>              — показать, что будет уничтожено
 *   bun run survey:purge <id> --confirm "<название>"
 */
import { client } from "./db";
import { PurgeRefused, purgePlan, purgeSurvey, type PurgePlan } from "./lib/surveyPurge";

const [id, ...rest] = process.argv.slice(2);
if (!id) {
  console.error("Использование: bun run survey:purge <id> [--confirm \"<название>\"]");
  process.exit(1);
}

const confirmIdx = rest.indexOf("--confirm");
const confirmed = confirmIdx >= 0 ? rest[confirmIdx + 1] : null;

const plan = await purgePlan(id);
if (!plan) {
  console.error(`Методика ${id} не найдена`);
  await client.end();
  process.exit(1);
}

function show(p: PurgePlan) {
  console.log(`\nМетодика: «${p.title}»`);
  console.log(`Снята с использования: ${p.archivedAt ?? "нет"}`);
  console.log("Будет уничтожено безвозвратно:");
  console.log(`  прохождений: ${p.responses}`);
  console.log(`  тревог этой методики: ${p.alerts}`);
  console.log(`  назначений: ${p.assignments}`);
  console.log(`  заключений (черновиков): ${p.conclusions}`);
  console.log(`  срабатываний правил: ${p.ruleHits}`);
  console.log(`  случаев только из её сигналов: ${p.casesRemoved}`);
  /*
   * То, чего прежняя сводка не говорила: случаи, начатые этой методикой,
   * держат и чужие сигналы. Они НЕ уничтожаются — переходят на оставшиеся.
   */
  console.log("Сохраняется:");
  console.log(`  случаев, переходящих на другие методики: ${p.casesMoved}`);
  console.log(`  сигналов других методик в них: ${p.keptSignals}`);
  if (p.signedConclusions) {
    console.log(`\nПодписанных заключений: ${p.signedConclusions} — чистка невозможна, пока они есть.`);
  }
}

show(plan);

if (confirmed !== plan.title) {
  console.log(
    `\nЧтобы удалить, повторите с точным названием:\n` +
      `  bun run survey:purge ${id} --confirm ${JSON.stringify(plan.title)}\n`,
  );
  await client.end();
  process.exit(confirmed === null ? 0 : 1);
}

try {
  await purgeSurvey(id, confirmed);
  console.log(`\nУдалено. Запись о чистке осталась в журнале доступа.`);
} catch (e) {
  console.error(`\n${e instanceof PurgeRefused ? "Отказ" : "Ошибка"}: ${e instanceof Error ? e.message : String(e)}`);
  console.error("Ничего не удалено, в журнал ничего не записано.");
  await client.end();
  process.exit(1);
}
await client.end();
