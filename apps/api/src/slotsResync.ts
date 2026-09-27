/**
 * Пересборка сетки слотов всем специалистам — командой.
 *
 *   bun apps/api/src/slotsResync.ts
 *
 * Тот же проход, что делает фоновая задача раз в сутки (lib/schedule.ts,
 * extendSlotHorizon; «Фонові задачі» в техпанели — slots.horizon). Нужен
 * тогда, когда ждать суток незачем: после миграции, меняющей правила сетки
 * (0105 — запрет пересечения слотов), после восстановления из копии, после
 * долгой остановки сервера. Две копии одного прохода разошлись бы на первой
 * же правке, поэтому здесь только вызов и отчёт.
 *
 * Системный контекст — внутри прохода, на чтение списка специалистов, а не
 * обёрткой вокруг всего, как у соседних команд: обёртка сложила бы
 * пересборку всех специалистов в одну транзакцию, и первая же ошибка одного
 * оставила бы остальных без сетки (почему — lib/scheduler.ts,
 * runDueSchedules). Каждый специалист пересобирается своей транзакцией и под
 * замком своего расписания (lockSchedule) — правка регистратора в ту же
 * минуту просто подождёт.
 *
 * Идемпотентна: повторный прогон ничего не добавляет. Занятые слоты не
 * трогаются никогда — выпавшие из расписания помечаются, а не отменяются.
 */
import { client } from "./db";
import { JobLocked, withJobLock } from "./lib/jobLock";
import { SLOT_HORIZON_JOB, extendSlotHorizon } from "./lib/schedule";

try {
  const report = await withJobLock(SLOT_HORIZON_JOB, () => extendSlotHorizon());
  console.log(`  ✓ сетка пересобрана: специалистов ${report.specialists}`);
  console.log(`    слотов добавлено: ${report.added}`);
  console.log(`    убрано свободных вне расписания: ${report.removed}`);
  if (report.flagged) console.log(`    занятых вне расписания помечено: ${report.flagged} — решает человек`);
} catch (error) {
  await client.end();
  if (error instanceof JobLocked) {
    // не сбой: ту же пересборку прямо сейчас делает сервер, и её итог виден в «Фонові задачі»
    console.log("  · пересборка уже идёт на сервере (фоновая задача slots.horizon) — итог в техпанели");
    process.exit(0);
  }
  console.error(`  ✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

await client.end();
