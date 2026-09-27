/**
 * Установка общего каталога методик и отделения по умолчанию.
 *
 *   bun apps/api/src/installCatalog.ts
 *   bun apps/api/src/installCatalog.ts --status        — только обзор, ничего не меняет
 *   bun apps/api/src/installCatalog.ts --force who5    — редакция каталога поверх правки учреждения
 *
 * Отдельный запуск, а не часть provision: provision приводит СХЕМУ, а это
 * наполнение. Смешивать их значило бы, что откат схемы задевает данные, а
 * повторный прогон миграций трогает методики, к которым уже привязаны
 * прохождения.
 *
 * Идемпотентен: повторный прогон ничего не дублирует и ничего не обновляет.
 * Правку учреждения (последняя версия выпущена в конструкторе) не трогает —
 * кроме ключей, названных в --force.
 */
import { baseDb } from "./db";
import { systemContext } from "./db/context";
import { CATALOG } from "./instruments/catalog";
import { catalogStatus, installCatalog } from "./lib/catalogInstall";
import { client } from "./db";

const args = process.argv.slice(2);

if (args.includes("--status")) {
  /*
   * Обзор перед решением «катить ли каталог поверх правки учреждения»:
   * что стоит, какая редакция и чьи последние версии. Ничего не меняет.
   */
  const rows = await systemContext(baseDb, () => catalogStatus());
  const word = { missing: "не стоит", current: "редакция каталога", behind: "прежняя редакция каталога", local: "правлена в учреждении" };
  for (const r of rows) {
    console.log(`  ${r.key}: ${word[r.state]}`);
    if (r.state === "local" || r.state === "behind") {
      for (const v of r.versions) console.log(`      v${v.version} · ${v.createdAt.slice(0, 16)} · ${v.note ?? "без заметки"}`);
    }
  }
  await client.end();
  process.exit(0);
}

/*
 * --force <ключи через запятую> — выкатить редакцию каталога и поверх правки
 * учреждения. Ключ, которого нет в каталоге, — отказ до всякой работы: опечатка
 * не должна молча превращаться в «ничего не сделано».
 */
const forceAt = args.indexOf("--force");
const force = forceAt >= 0 ? (args[forceAt + 1] ?? "").split(",").map((k) => k.trim()).filter(Boolean) : [];
const unknown = force.filter((k) => !CATALOG.some((e) => e.key === k));
if (forceAt >= 0 && (!force.length || unknown.length)) {
  console.error(`  ✗ --force: ${force.length ? `нет в каталоге: ${unknown.join(", ")}` : "не названо ни одного ключа"}`);
  await client.end();
  process.exit(1);
}

const report = await systemContext(baseDb, () => installCatalog({ force }));

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
if (report.updated.length) console.log(`  ✓ обновлено до редакции каталога: ${report.updated.join(", ")}`);
if (report.keptLocal.length) {
  console.log(`  · правлены в учреждении, каталог их не трогал: ${report.keptLocal.join(", ")}`);
}

await client.end();
