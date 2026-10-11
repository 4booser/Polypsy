-- Происхождение доступов, выданных набором до волны 14 (волна 21, #150;
-- неполное исправление #34 в 0114).
--
-- 0114 завела survey_access.via_assignment_id — назначение, которое выдало
-- строку доступа, — и заполнила её для существующих строк по пометке. Но
-- искала только пометки-коды (⟦note.battery…, ⟦note.schedule…,
-- ⟦note.cascade…), а коды пишутся с волны 14 (w14:srvstrings). До неё те
-- же пути выдачи писали фразу: «Батарея «…»» (ручное назначение набора),
-- «Расписание «…»», «Каскад по результату скрининга». Такие строки остались
-- без происхождения, и отмена назначения (lib/batteries.ts,
-- revokeIssuedAccess — снимает только строки своего назначения) их не
-- трогает: пациент открывает (200) и сдаёт методику из снятого набора.
--
-- Правило то же, что у 0114: строка с такой пометкой, у человека которой
-- есть открытое назначение с этой методикой в составе, считается выданной
-- самым свежим таким назначением. Только фразы, без кодов: строка с кодом и
-- пустым происхождением после 0114 — это действующий доступ другого
-- основания, который набор лишь продлил (lib/grantAccess.ts, "extend"), и
-- присваивать его набору нельзя. Строки ручной выдачи и группы несут свою
-- пометку (текст специалиста или пусто) и под условие не попадают.
--
-- Идемпотентно: заполняются только строки с пустым происхождением, и
-- повторный прогон не находит ни одной.
UPDATE survey_access sa
SET via_assignment_id = pick.assignment_id
FROM (
  SELECT DISTINCT ON (s.survey_id, s.user_id)
    s.survey_id, s.user_id, ba.id AS assignment_id
  FROM survey_access s
  JOIN battery_assignments ba
    ON ba.user_id = s.user_id AND ba.completed_at IS NULL AND ba.cancelled_at IS NULL
  JOIN battery_assignment_items ai
    ON ai.assignment_id = ba.id AND ai.survey_id = s.survey_id
  WHERE s.via_assignment_id IS NULL
    AND (s.note LIKE 'Батарея «%' OR s.note LIKE 'Расписание «%' OR s.note = 'Каскад по результату скрининга')
  ORDER BY s.survey_id, s.user_id, ba.assigned_at DESC, ba.id
) pick
WHERE sa.survey_id = pick.survey_id
  AND sa.user_id = pick.user_id
  AND sa.via_assignment_id IS NULL;
