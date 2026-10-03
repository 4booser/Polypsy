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
--> statement-breakpoint
-- ═══ survey_access.via_assignment_id: чьё это разрешение ═══
--
-- Отмена назначения меняла только cancelled_at (п. 4 того же разбора):
-- доступ к методикам, выданный назначением, оставался до своего срока или
-- бессрочно — пациент открывал (200) и сдавал (201) методику из снятого
-- набора, другого основания не имея. Удалять строку survey_access целиком
-- нельзя: ключ — пара «методика и человек», и ту же строку могли выдать
-- руками, группой или другим назначением.
--
-- Поэтому у строки доступа появляется происхождение — назначение, которое
-- её выдало (пишет grantAccess на всех путях выдачи набора). Ручная выдача и
-- группа его снимают, как и прочие поля перевыдачи; продление набором поверх
-- действующего независимого основания его не присваивает (lib/grantAccess.ts).
-- Отмена снимает строки СВОЕГО назначения и только когда ни одно другое
-- открытое назначение этого человека не выдаёт ту же методику — иначе
-- переписывает происхождение на него (lib/batteries.ts, revokeIssuedAccess).
--
-- Заполнение для существующих строк — один раз и по пометке: до этой
-- миграции происхождение не записывалось, и у строки с кодом пометки
-- набора, расписания или каскада, у которой есть открытое назначение с этой
-- методикой в составе, им и считается самое свежее такое назначение.
-- Устойчивой связью дальше служит колонка, а не пометка.
ALTER TABLE survey_access ADD COLUMN IF NOT EXISTS via_assignment_id text
  REFERENCES battery_assignments(id) ON DELETE SET NULL;
--> statement-breakpoint
UPDATE survey_access sa
SET via_assignment_id = (
  SELECT ba.id FROM battery_assignments ba
  JOIN battery_assignment_items ai ON ai.assignment_id = ba.id
  WHERE ba.user_id = sa.user_id AND ai.survey_id = sa.survey_id
    AND ba.completed_at IS NULL AND ba.cancelled_at IS NULL
  ORDER BY ba.assigned_at DESC, ba.id
  LIMIT 1
)
WHERE sa.via_assignment_id IS NULL
  AND (sa.note LIKE '⟦note.battery%' OR sa.note LIKE '⟦note.schedule%' OR sa.note LIKE '⟦note.cascade%');
