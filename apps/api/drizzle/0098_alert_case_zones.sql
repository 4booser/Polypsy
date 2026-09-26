-- Случай риска живёт в одной зоне видимости (внешний разбор, P1).
--
-- ═══ Что было ═══
--
-- Случай собирался по человеку поверх зон: тревога методики группы Б
-- дописывалась в случай, начатый методикой группы А. А политика строк
-- alert_cases_access (0029) и выборка очереди держат случай за его ПЕРВОЙ
-- методикой. Итог в бою: сотрудник группы Б своего сигнала не видел вовсе,
-- а сотрудник группы А закрывал его разбором, не видя (разбор ставит исход
-- на все сигналы случая).
--
-- ═══ Что стало ═══
--
-- Новые сигналы ищут открытый случай человека только в своей зоне
-- (lib/alertCases.ts, caseZoneSql): группа методики, а у методики без группы
-- — её создатель. Правило то же, что у rls_admin_sees_survey, поэтому
-- политика 0029 теперь права без правок: все сигналы случая видны ровно тем,
-- кому виден случай. Почему делим случаи, а не расширяем политику «по любой
-- тревоге случая», — в комментарии у attachCaseRow.
--
-- Здесь — то, что уже накопилось: сигналы не своей зоны уходят в отдельный
-- случай на пару «прежний случай + зона».
--
--   · открытый остаётся открытым и ничьим: прежний «взял» относился к
--     человеку, который этих сигналов не видел;
--   · разобранный переносит решение как было (кто, когда, исход, заметка) —
--     сигналы и сами уже несут эту отметку, переписывать историю нельзя, —
--     и помечается merged_from_legacy: решение принималось не по ним, и
--     экран разбора говорит об этом прямо («зібрано автоматично»);
--   · у прежнего случая тяжесть и время последнего сигнала пересчитываются
--     по тому, что в нём осталось. Время открытия не трогается: первый
--     сигнал случая всегда из зоны его первой методики.
--
-- Идентификатор нового случая — md5 от пары «прежний случай + зона»: без
-- временной таблицы вставка и перенос сигналов сходятся на одном ключе, а
-- повторный вызов не плодит дублей.
--
-- Функцией, а не голыми операторами: её вызывает тест, собравший смешанный
-- случай руками (alertCaseZones.test.ts), — иначе миграция проверялась бы
-- только на пустой тестовой базе. Прикладной роли она не выдаётся.

CREATE OR REPLACE FUNCTION alert_cases_split_by_zone() RETURNS integer AS $$
DECLARE
  affected text[];
  moved integer;
BEGIN
  SELECT array_agg(DISTINCT ra.case_id) INTO affected
  FROM risk_alerts ra
  JOIN surveys s ON s.id = ra.survey_id
  JOIN alert_cases ac ON ac.id = ra.case_id
  JOIN surveys cs ON cs.id = ac.survey_id
  WHERE coalesce(s.group_id, 'u:' || s.created_by) <> coalesce(cs.group_id, 'u:' || cs.created_by);

  IF affected IS NULL THEN
    RETURN 0;
  END IF;

  INSERT INTO alert_cases (
    id, user_id, survey_id, opened_at, last_alert_at, severity,
    assigned_to, assigned_at, acknowledged_by, acknowledged_at, note, outcome, merged_from_legacy
  )
  SELECT
    md5(st.case_id || '|' || st.zone)::uuid::text,
    ac.user_id,
    (array_agg(st.survey_id ORDER BY st.at, st.alert_id))[1],
    min(st.at),
    max(st.at),
    CASE WHEN bool_or(st.severity = 'severe') THEN 'severe' ELSE 'moderate' END,
    NULL,
    NULL,
    ac.acknowledged_by,
    ac.acknowledged_at,
    ac.note,
    ac.outcome,
    ac.acknowledged_at IS NOT NULL OR ac.merged_from_legacy
  FROM (
    SELECT ra.id AS alert_id, ra.case_id, ra.survey_id, ra.severity, ra.at,
           coalesce(s.group_id, 'u:' || s.created_by) AS zone
    FROM risk_alerts ra
    JOIN surveys s ON s.id = ra.survey_id
    JOIN alert_cases c ON c.id = ra.case_id
    JOIN surveys cs ON cs.id = c.survey_id
    WHERE ra.case_id = ANY (affected)
      AND coalesce(s.group_id, 'u:' || s.created_by) <> coalesce(cs.group_id, 'u:' || cs.created_by)
  ) st
  JOIN alert_cases ac ON ac.id = st.case_id
  GROUP BY st.case_id, st.zone, ac.user_id, ac.acknowledged_by, ac.acknowledged_at, ac.note, ac.outcome,
           ac.merged_from_legacy
  ON CONFLICT (id) DO NOTHING;

  UPDATE risk_alerts ra
  SET case_id = md5(ra.case_id || '|' || coalesce(s.group_id, 'u:' || s.created_by))::uuid::text
  FROM surveys s, alert_cases ac, surveys cs
  WHERE s.id = ra.survey_id
    AND ac.id = ra.case_id
    AND cs.id = ac.survey_id
    AND ra.case_id = ANY (affected)
    AND coalesce(s.group_id, 'u:' || s.created_by) <> coalesce(cs.group_id, 'u:' || cs.created_by);
  GET DIAGNOSTICS moved = ROW_COUNT;

  UPDATE alert_cases ac
  SET severity = x.severity, last_alert_at = x.last_at
  FROM (
    SELECT ra.case_id,
           CASE WHEN bool_or(ra.severity = 'severe') THEN 'severe' ELSE 'moderate' END AS severity,
           max(ra.at) AS last_at
    FROM risk_alerts ra
    WHERE ra.case_id = ANY (affected)
    GROUP BY ra.case_id
  ) x
  WHERE ac.id = x.case_id;

  RETURN moved;
END
$$ LANGUAGE plpgsql;--> statement-breakpoint

REVOKE ALL ON FUNCTION alert_cases_split_by_zone() FROM PUBLIC;--> statement-breakpoint

SELECT alert_cases_split_by_zone();
