/**
 * Физическое удаление методики. Единственный способ действительно стереть
 * её из базы — и он намеренно живёт только на сервере.
 *
 * Из консоли методику можно лишь снять с использования: строка `surveys`
 * связана каскадом с прохождениями, баллами, тревогами и назначениями, и
 * настоящее удаление уносит клиническую историю живых людей. Такое решение
 * не должно приниматься нажатием кнопки в браузере.
 *
 * Запуск:
 *   bun run survey:purge <id>              — показать, что будет уничтожено
 *   bun run survey:purge <id> --confirm "<название>"
 */
import { eq, sql } from "drizzle-orm";
import { t } from "@quizzy/shared";
import { client, db } from "./db";
import { auditSystem } from "./lib/audit";
import { responses, riskAlerts, surveyAccess, surveys } from "./db/schema";

const [id, ...rest] = process.argv.slice(2);
if (!id) {
  console.error("Использование: bun run survey:purge <id> [--confirm \"<название>\"]");
  process.exit(1);
}

const confirmIdx = rest.indexOf("--confirm");
const confirmed = confirmIdx >= 0 ? rest[confirmIdx + 1] : null;

const survey = await db.query.surveys.findFirst({ where: eq(surveys.id, id) });
if (!survey) {
  console.error(`Методика ${id} не найдена`);
  process.exit(1);
}

const title = t(survey.title as never);

// снятие с использования — обязательный предварительный шаг: между решением
// и необратимым действием должен быть промежуток, в котором можно передумать
if (!survey.archivedAt) {
  console.error(`«${title}» в работе. Сначала снимите её с использования в консоли.`);
  process.exit(1);
}

const count = async (table: typeof responses | typeof riskAlerts | typeof surveyAccess) => {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq((table as typeof responses).surveyId, id));
  return row?.n ?? 0;
};

const stats = {
  прохождений: await count(responses),
  тревог: await count(riskAlerts),
  назначений: await count(surveyAccess),
};

console.log(`\nМетодика: «${title}»`);
console.log(`Снята с использования: ${survey.archivedAt}`);
console.log("Будет уничтожено безвозвратно:");
for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v}`);

if (confirmed !== title) {
  console.log(
    `\nЧтобы удалить, повторите с точным названием:\n` +
      `  bun run survey:purge ${id} --confirm ${JSON.stringify(title)}\n`,
  );
  await client.end();
  process.exit(confirmed === null ? 0 : 1);
}

/*
 * Запись в журнал ДО удаления: журнал защищён от правки хэш-цепочкой и
 * триггерами, поэтому запись переживёт саму методику — иначе после чистки
 * не осталось бы следа о том, что здесь вообще что-то было.
 */
await auditSystem({
  action: "survey.purge",
  resourceType: "survey",
  resourceId: id,
  details: { title, archivedAt: survey.archivedAt, ...stats },
});

await db.delete(surveys).where(eq(surveys.id, id));
console.log(`\nУдалено. Запись о чистке осталась в журнале доступа.`);
await client.end();
