-- Жизненный цикл данных вокруг случаев риска (клиническое ревью волны 12).
--
-- ═══ risk_alerts.case_id: CASCADE → NO ACTION ═══
--
-- Случай собирает сигналы нескольких методик одной зоны видимости, а сам
-- держится за методику, с которой начался (alert_cases.survey_id, каскад).
-- Физическая чистка методики А уносила её случаи — и каскадом по case_id
-- все сигналы внутри них, в том числе сигналы методики Б. Проверено на
-- стенде: после чистки А у Б оставалось 0 тревог из 10, а сводка «будет
-- уничтожено» считала только тревоги А.
--
-- Чистка теперь переносит такой случай на оставшиеся сигналы до удаления
-- (lib/surveyPurge.ts). Здесь — страховка под ней: случай нельзя удалить,
-- пока на него ссылается хоть один сигнал. NO ACTION, а не RESTRICT, и это
-- существенно: проверка идёт в конце оператора, поэтому удаление методики,
-- которое каскадом уносит и её сигналы, и её собственные случаи, проходит.
-- Не проходит только то, что прежде молча уничтожало чужие сигналы: удаление
-- случая, в котором остались сигналы другой методики или другого запроса.
--
-- Почему не SET NULL: сигнал без случая в очереди не показывается вовсе —
-- это та же потеря, только без записи об ошибке. Отказ базы громче.

ALTER TABLE risk_alerts DROP CONSTRAINT IF EXISTS risk_alerts_case_id_alert_cases_id_fk;--> statement-breakpoint
ALTER TABLE risk_alerts ADD CONSTRAINT risk_alerts_case_id_alert_cases_id_fk
  FOREIGN KEY (case_id) REFERENCES alert_cases(id) ON DELETE NO ACTION;--> statement-breakpoint

-- ═══ decision_rules.group_id: SET NULL → NO ACTION ═══
--
-- Правило без группы — правило всего учреждения (lib/decisions.ts: группа
-- NULL подходит к любой методике). Удаление пустой группы обнуляло группу у
-- её правил, и правило, написанное для одной группы, начинало предлагать
-- шаги всем. Удаление группы с правилами теперь отказ (routes/groups.ts
-- перечисляет правила вместе с методиками и наборами), а внешний ключ —
-- последняя защита: без маршрута группу с правилами не удалить и из SQL.

ALTER TABLE decision_rules DROP CONSTRAINT IF EXISTS decision_rules_group_id_fkey;--> statement-breakpoint
ALTER TABLE decision_rules DROP CONSTRAINT IF EXISTS decision_rules_group_id_survey_groups_id_fk;--> statement-breakpoint
ALTER TABLE decision_rules ADD CONSTRAINT decision_rules_group_id_survey_groups_id_fk
  FOREIGN KEY (group_id) REFERENCES survey_groups(id) ON DELETE NO ACTION;
