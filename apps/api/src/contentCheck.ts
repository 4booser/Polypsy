/**
 * Проверка опубликованного контента в базе.
 *
 * Встроенные методики проверяются тестом по файлам, но в работе живут ещё и
 * заведённые через конструктор и импортированные. Их никто не проверяет, а
 * поломка ключа не роняет приложение — она молча даёт неверный балл.
 *
 * Запускается перед выкаткой: ненулевой код возврата означает «не
 * выкатывать». Ошибка в опубликованной методике дороже задержки релиза.
 *
 *   bun run content:check          — только ошибки валят проверку
 *   bun run content:check --strict — предупреждения тоже
 */
import { eq } from "drizzle-orm";
import { t, validateSurvey, type Issue } from "@quizzy/shared";
import { client, db } from "./db";
import { surveys } from "./db/schema";
import { getSurvey } from "./lib/surveys";

const strict = process.argv.includes("--strict");

const published = await db
  .select({ id: surveys.id, title: surveys.title, archivedAt: surveys.archivedAt })
  .from(surveys)
  .where(eq(surveys.status, "published"));

console.log(`Опубликованных методик: ${published.length}\n`);

let errors = 0;
let warnings = 0;

for (const row of published) {
  const title = t(row.title as never);
  const survey = await getSurvey(row.id);
  if (!survey) {
    console.log(`✖ ${title}: опубликована, но содержимое версии не читается`);
    errors++;
    continue;
  }

  /*
   * Валидатор работает с номерами пунктов и кодами шкал, как в пособии, а
   * в базе ключ хранится ссылками. Тот же перевод делает страница проверки
   * в конструкторе — иначе поправки выглядели бы битыми.
   */
  const indexById = new Map(survey.questions.map((q, i) => [q.id, i + 1]));
  const issues: Issue[] = validateSurvey({
    questions: survey.questions,
    scales: survey.scales.map((s) => ({
      ...s,
      key: s.items.flatMap((i) => {
        const item = indexById.get(i.questionId);
        return item ? [{ item, matchKey: i.matchKey, weight: i.weight }] : [];
      }),
      corrections: s.corrections.map((c) => ({ from: c.sourceScaleCode, coefficient: c.coefficient })),
    })),
  } as never);

  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warning");
  errors += errs.length;
  warnings += warns.length;

  const mark = errs.length ? "✖" : warns.length ? "⚠" : "✔";
  const note = row.archivedAt ? " (снята с использования)" : "";
  console.log(`${mark} ${title}${note} — вопросов ${survey.questions.length}, шкал ${survey.scales.length}`);
  for (const i of [...errs, ...warns]) {
    console.log(`    ${i.level === "error" ? "ошибка" : "предупреждение"} · ${i.where}: ${i.message}`);
  }
}

console.log(`\nОшибок: ${errors}, предупреждений: ${warnings}`);
await client.end();

if (errors > 0) {
  console.error("Выкатывать нельзя: в опубликованных методиках есть структурные ошибки.");
  process.exit(1);
}
if (strict && warnings > 0) {
  console.error("Строгий режим: предупреждения тоже считаются препятствием.");
  process.exit(1);
}
