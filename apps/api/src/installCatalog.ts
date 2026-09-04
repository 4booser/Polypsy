/**
 * Установка общего каталога методик и отделения по умолчанию.
 *
 *   bun apps/api/src/installCatalog.ts
 *
 * Отдельный запуск, а не часть provision: provision приводит СХЕМУ, а это
 * наполнение. Смешивать их значило бы, что откат схемы задевает данные, а
 * повторный прогон миграций трогает методики, к которым уже привязаны
 * прохождения.
 *
 * Идемпотентен: повторный прогон ничего не дублирует и ничего не обновляет.
 */
import { baseDb } from "./db";
import { systemContext } from "./db/context";
import { installCatalog } from "./lib/catalogInstall";
import { client } from "./db";

const report = await systemContext(baseDb, () => installCatalog());

if (report.notReady) {
  /*
   * Не ошибка и не отказ: сотрудников ещё нет, записать методику не на
   * кого. Так бывает ровно один раз — между первым выкатом и заведением
   * администратора, — и само проходит на следующем выкате. Валить из-за
   * этого выкат было бы неверно, молчать — тоже.
   */
  console.log(`  · каталог не ставился: ${report.notReady}`);
  console.log("    заведите администратора (install.ts) — следующий выкат поставит каталог");
  await client.end();
  process.exit(0);
}

console.log(
  report.departmentCreated
    ? `  ✓ отделение заведено: ${report.departmentId}`
    : `  · отделение уже было: ${report.departmentId}`,
);
if (report.installed.length) console.log(`  ✓ поставлено методик: ${report.installed.join(", ")}`);
if (report.skipped.length) console.log(`  · уже стояли: ${report.skipped.join(", ")}`);

await client.end();
