/**
 * Действуют ли политики строк на этом подключении.
 *
 *   bun apps/api/src/rlsReport.ts
 *
 * Отдельным запуском, а не только командой консоли: подключение владельцем
 * базы обходит все политики, при этом всё работает и все экраны рисуются.
 * Отличить это от исправной работы нельзя ничем, кроме такой проверки, — и
 * спрашивать её надо уметь снаружи приложения, а не только изнутри.
 */
import { renderNote } from "@quizzy/shared";
import { client } from "./db";
import { checkRls } from "./lib/rlsGuard";

const report = await checkRls();
if (report.bypasses) {
  console.error("  ✗ ПОЛИТИКИ НЕ ДЕЙСТВУЮТ");
  console.error(`    роль: ${report.role}`);
  // причина хранится кодом (lib/rlsGuard.ts); терминал — по-русски, как весь вывод скриптов
  console.error(`    причина: ${renderNote(report.reason, "ru") ?? "неизвестна"}`);
  console.error(`    таблиц с включённой RLS во владении: ${report.ownedWithRls}`);
  await client.end();
  process.exit(1);
}
console.log(`  ✓ политики строк действуют; роль: ${report.role}`);
await client.end();
