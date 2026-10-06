-- Назначение не уходит вместе с набором (волна 18, участок races; внешний
-- разбор 2026-09-30, #107).
--
-- battery_assignments.battery_id стоял на ON DELETE CASCADE. Маршрут
-- удаления набора отказывает, если назначения есть, но его проверка и
-- DELETE шли отдельными запросами: выдача назначения, вставшая за той же
-- строкой набора, проходила 201, удаление следом — 204, и каскад уносил
-- назначение, чей id уже отдан клиенту, оставляя пациенту доступ к методике
-- без назначения, которое его выдало. Маршруты теперь берут замок на строке
-- набора (routes/batteries.ts), а база больше не даёт удалить набор с
-- историей молча: RESTRICT. Завершённое назначение — запись о том, что
-- человек реально проходил этот набор; отработавший набор архивируют, а не
-- удаляют.
--
-- Уборка вымышленных данных (lib/demoFill.ts) удаляет назначения
-- вымышленных наборов явно перед самими наборами.
ALTER TABLE "battery_assignments" DROP CONSTRAINT IF EXISTS "battery_assignments_battery_id_batteries_id_fk";
--> statement-breakpoint
ALTER TABLE "battery_assignments" ADD CONSTRAINT "battery_assignments_battery_id_batteries_id_fk"
  FOREIGN KEY ("battery_id") REFERENCES "public"."batteries"("id") ON DELETE restrict ON UPDATE no action;
