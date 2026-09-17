/**
 * Перепись таблиц, на которые в коде не осталось ни одной ссылки.
 *
 *   bun apps/api/src/leftovers.ts
 *
 * Зачем отдельная команда. Двенадцать таблиц пережили снятые возможности —
 * киоск, консилиумы, цели лечения, маршруты помощи, дежурные смены, запрос
 * информанта, кризисный режим. В коде их не зовёт никто, и соблазн снести их
 * миграцией велик: мёртвая таблица вводит в заблуждение читающего схему.
 *
 * Сносить вслепую нельзя. Часть из них могла успеть набрать клинические
 * записи до того, как возможность убрали, и тогда удаление таблицы — это
 * потеря истории, а не уборка. План говорит прямо: сроки хранения
 * бессрочные, автоматического удаления по сроку нет. Значит решение
 * принимает человек, а команда даёт ему то, чего не хватает для решения:
 * сколько там строк В БОЮ. На стенде они пусты по определению, и смотреть на
 * стенд бессмысленно.
 *
 * Команда только читает. Ничего не удаляет и не меняет — намеренно: у неё
 * нет и не должно быть права на решение, которое принимает человек.
 */
import { sql } from "drizzle-orm";
import { baseDb, client } from "./db";
import { systemContext } from "./db/context";

/* Порядок — как в схеме, чтобы перепись читалась рядом с ней */
const LEFTOVERS = [
  "kiosk_sessions",
  "kiosk_participants",
  "case_conferences",
  "conference_opinions",
  "treatment_goals",
  "pathways",
  "pathway_steps",
  "pathway_instances",
  "pathway_progress",
  "duty_shifts",
  "informant_requests",
  "crisis_periods",
] as const;

const counts = await systemContext(baseDb, async () => {
  const out: { table: string; rows: number | null }[] = [];
  for (const table of LEFTOVERS) {
    try {
      const res = await baseDb.execute<{ n: number }>(
        sql`select count(*)::int as n from ${sql.identifier(table)}`,
      );
      out.push({ table, rows: Number([...res][0]?.n ?? 0) });
    } catch {
      /* таблицы может уже не быть — это ответ, а не сбой */
      out.push({ table, rows: null });
    }
  }
  return out;
});

const busy = counts.filter((c) => (c.rows ?? 0) > 0);
for (const c of counts) {
  const mark = c.rows === null ? "нет в базе" : c.rows === 0 ? "пусто" : `СТРОК: ${c.rows}`;
  console.log(`  ${c.table.padEnd(22)} ${mark}`);
}
console.log(
  busy.length
    ? `\n  ⚠ непустых таблиц: ${busy.length}. Удалять нельзя без решения человека: там записи.`
    : "\n  ✓ все пусты: удаление таблиц ничего не потеряет",
);

await client.end();
