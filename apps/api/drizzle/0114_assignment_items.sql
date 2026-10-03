-- Состав назначения набора — снимок на момент выдачи (волна 16, участок
-- batteries; внешний разбор 2026-09-28, п. 3).
--
-- Назначение ссылалось на изменяемый набор, и его шаги на экране пациента,
-- допуск к сдаче и завершение читались из текущего состава battery_items.
-- Правка набора молча меняла уже выданные назначения: добавленная
-- обязательная методика появлялась у пациента шагом, но доступа на неё
-- назначение не выдавало — открытие 404, назначение не завершить без ручной
-- выдачи; удалённая методика пропадала из завершённых назначений, и история
-- обследования переписывалась задним числом.
--
-- Теперь у назначения свой состав: при выдаче сюда копируются шаги, которые
-- оно выдало вместе с доступом, и дальше экран, допуск и завершение читают
-- отсюда (lib/batteries.ts). Правка набора действует на будущие назначения;
-- выданные остаются в том составе, в каком их выдали. Существующие
-- назначения получают снимок с текущего состава набора — другого у них не
-- было, и именно его показывал экран до правки.
--
-- Политика строк: строка видна и пишется тогда же, когда видно само
-- назначение, — подзапрос к battery_assignments идёт под политикой той
-- таблицы (0108: своя строка у пациента, зона батареи и зона пациента у
-- администратора, система и суперадмин). Второго правила видимости для
-- одних и тех же данных не заводится. Права роли приложения — умолчанием
-- схемы (provision.ts, ALTER DEFAULT PRIVILEGES), как у report_links (0109).

CREATE TABLE IF NOT EXISTS battery_assignment_items (
  assignment_id text NOT NULL REFERENCES battery_assignments(id) ON DELETE CASCADE,
  survey_id text NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  position integer NOT NULL,
  required boolean NOT NULL,
  CONSTRAINT battery_assignment_items_pkey PRIMARY KEY (assignment_id, survey_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS battery_assignment_items_survey_idx ON battery_assignment_items (survey_id);
--> statement-breakpoint
INSERT INTO battery_assignment_items (assignment_id, survey_id, position, required)
SELECT ba.id, bi.survey_id, bi.position, bi.required
FROM battery_assignments ba
JOIN battery_items bi ON bi.battery_id = ba.battery_id
ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE battery_assignment_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS battery_assignment_items_access ON battery_assignment_items;
--> statement-breakpoint
CREATE POLICY battery_assignment_items_access ON battery_assignment_items FOR ALL USING (
  EXISTS (SELECT 1 FROM battery_assignments ba WHERE ba.id = assignment_id)
) WITH CHECK (
  EXISTS (SELECT 1 FROM battery_assignments ba WHERE ba.id = assignment_id)
);
