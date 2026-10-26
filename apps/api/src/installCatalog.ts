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
    // настройки строки, правленные в учреждении: обычное обновление их сохранит, --force вернёт каталоговые
    if (r.localFields.length) console.log(`      настройки учреждения: ${r.localFields.join(", ")}`);
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
/*
 * Группа каталога (CATALOG_GROUP_ID в lib/catalogInstall.ts): методики каталога
 * видит тот, кого суперадмин назначит её администратором.
 */
if (report.groupCreated) {
  console.log("  ✓ группа «Каталог методик» заведена: назначьте врачей её администраторами, и они увидят каталог");
}
if (report.grouped.length) console.log(`  ✓ перенесены в группу каталога: ${report.grouped.join(", ")}`);
if (report.installed.length) console.log(`  ✓ поставлено методик: ${report.installed.join(", ")}`);
if (report.skipped.length) console.log(`  · уже стояли: ${report.skipped.join(", ")}`);
if (report.updated.length) console.log(`  ✓ обновлено до редакции каталога: ${report.updated.join(", ")}`);
if (report.keptLocal.length) {
  console.log(`  · правлены в учреждении, каталог их не трогал: ${report.keptLocal.join(", ")}`);
}
for (const [key, fields] of Object.entries(report.keptSettings)) {
  console.log(`  · ${key}: настройки учреждения сохранены (${fields.join(", ")}) — --force ${key} вернёт каталоговые`);
}
// направление (instruments/catalogDomains.ts) у стоявших методик — без новой версии
if (report.domainSet.length) console.log(`  ✓ направление проставлено: ${report.domainSet.join(", ")}`);
// источник для персонала («Джерело» в паспорте методики) — тоже без версии; правку суперадмина выкат не трогает
if (report.sourceNoteSet.length) console.log(`  ✓ источник для персонала обновлён: ${report.sourceNoteSet.join(", ")}`);

/*
 * Наборы-заготовки (instruments/catalogBatteries.ts): заводятся один раз, дальше
 * принадлежат отделению. Пропущенная методика — не отказ: набор заведён без неё.
 */
const b = report.batteries;
if (b.installed.length) console.log(`  ✓ заведено наборов: ${b.installed.join(", ")}`);
for (const [key, missing] of Object.entries(b.missingItems)) {
  console.log(`  ! ${key}: заведён без методик, которых нет в базе или они сняты: ${missing.join(", ")}`);
}
if (b.kept.length) console.log(`  · наборы уже заведены, ими распоряжается отделение: ${b.kept.join(", ")}`);
if (b.removed.length) console.log(`  · наборы удалены отделением, заново не заводятся: ${b.removed.join(", ")}`);
if (b.pending.length) console.log(`  ! наборы не заведены — ни одной их методики нет в базе: ${b.pending.join(", ")}`);

await client.end();
