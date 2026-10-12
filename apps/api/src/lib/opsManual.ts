/**
 * Задачи, которые техпанель может запустить руками («Запустити зараз»).
 *
 * Решение заказчика 2026-09-26: кнопка у задач, которые безопасно
 * запускать вне такта. Безопасно здесь значит три вещи сразу:
 *
 *   — идемпотентно: второй проход подряд ничего не портит и не удваивает;
 *   — не выдаёт людям ничего: ни заданий, ни пушей, ни писем пациентам.
 *     Поэтому расписания обследований, рассылки и напоминания сюда не
 *     входят — их лишний проход виден человеку как лишнее сообщение;
 *   — один проход за раз на все реплики: замок в базе (lib/jobLock.ts),
 *     поверх отметки «виконується» в реестре процесса.
 *
 * В списке:
 *
 *   search.reindex — пересборка слепого индекса записей (lib/noteReindex.ts,
 *     та же функция, что у команды reindex.ts);
 *   catalog.install — установка общего каталога методик (lib/catalogInstall,
 *     та же, что у installCatalog.ts): идемпотентна по построению;
 *   retention — чистка потока событий и мёртвых семей refresh-токенов по
 *     сроку (retention.ts);
 *   ops.alerts — проверка правил оповещений (opsAlerts.ts);
 *   data.quality — «перепроверить» «Якість даних»: проверки целостности
 *     записей и новый сохранённый итог (dataChecks.ts, #189). Только чтение
 *     данных и строка итога.
 *
 * «Пересчёт аналитики» (analytics.cache) убран (#187): он сбрасывал кэш
 * lib/analyticsCache.ts, которым ни один маршрут не пользовался, — кнопка
 * ничего не делала. Аналитика считается на каждый запрос, и пересчитывать
 * нечего.
 */
import { baseDb } from "../db";
import { systemContext } from "../db/context";
import { DATA_QUALITY_JOB, refreshDataQuality } from "./dataChecks";
import { installCatalog } from "./catalogInstall";
import { withJobLock } from "./jobLock";
import { log } from "./log";
import { reindexNotes } from "./noteReindex";
import { ALERT_JOB, runAlertChecksLocked } from "./opsAlerts";
import { registerRunnable } from "./opsJobs";
import { runRetentionOnce } from "./retention";

export const MANUAL_JOBS = [
  "search.reindex",
  "catalog.install",
  "retention",
  ALERT_JOB,
  DATA_QUALITY_JOB,
] as const;

let registered = false;

/** Завести ручные задачи в реестре. Повторный вызов ничего не удваивает */
export function registerManualJobs(): void {
  if (registered) return;
  registered = true;

  registerRunnable("search.reindex", () => withJobLock("search.reindex", () => systemContext(baseDb, reindexNotes)));

  registerRunnable("catalog.install", () =>
    withJobLock("catalog.install", async () => {
      const report = await systemContext(baseDb, () => installCatalog());
      log.info("ops.manual.catalog_install", {
        installed: report.installed.length,
        updated: report.updated.length,
        skipped: report.skipped.length,
        notReady: report.notReady ?? null,
      });
      return report;
    }),
  );

  registerRunnable("retention", () => withJobLock("retention", () => runRetentionOnce()));

  registerRunnable(ALERT_JOB, runAlertChecksLocked);

  registerRunnable(DATA_QUALITY_JOB, () => refreshDataQuality("manual"));
}
