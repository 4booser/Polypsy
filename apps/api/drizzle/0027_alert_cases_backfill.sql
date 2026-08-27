-- Сворачивание существующих тревог в случаи.
--
-- Правило: один человек + одна методика + сутки = один случай. Сутки, а не
-- общее окно в 72 часа, выбраны намеренно: старые тревоги накопились без
-- понятия случая, и склеивать далеко отстоящие эпизоды в один задним числом
-- значило бы придумывать за специалиста.
--
-- Анонимные тревоги (user_id is null) случая не получают: разбирать некого,
-- и они остаются как есть.

WITH numbered AS (
  SELECT
    a.id,
    a.user_id,
    a.survey_id,
    a.at,
    a.severity,
    a.acknowledged_at,
    a.acknowledged_by,
    a.note,
    a.outcome,
    -- новая группа начинается, если разрыв с предыдущей тревогой больше суток
    CASE
      WHEN LAG(a.at) OVER w IS NULL THEN 1
      WHEN a.at - LAG(a.at) OVER w > interval '1 day' THEN 1
      ELSE 0
    END AS starts_group
  FROM risk_alerts a
  WHERE a.user_id IS NOT NULL AND a.case_id IS NULL
  WINDOW w AS (PARTITION BY a.user_id, a.survey_id ORDER BY a.at)
),
grouped AS (
  SELECT *, SUM(starts_group) OVER (PARTITION BY user_id, survey_id ORDER BY at) AS grp
  FROM numbered
),
cases AS (
  SELECT
    gen_random_uuid()::text AS case_id,
    user_id,
    survey_id,
    grp,
    MIN(at)                                     AS opened_at,
    MAX(at)                                     AS last_alert_at,
    -- случай не легче худшего своего сигнала
    CASE WHEN bool_or(severity = 'severe') THEN 'severe' ELSE 'moderate' END AS severity,
    -- разобранным случай считается, только если разобраны ВСЕ его тревоги:
    -- иначе часть сигналов осталась бы без решения внутри закрытой записи
    CASE WHEN bool_and(acknowledged_at IS NOT NULL) THEN MAX(acknowledged_at) END AS acknowledged_at,
    (array_remove(array_agg(acknowledged_by ORDER BY at), NULL))[1] AS acknowledged_by,
    -- исход берётся самый тяжёлый из проставленных
    CASE
      WHEN bool_or(outcome = 'confirmed')       THEN 'confirmed'
      WHEN bool_or(outcome = 'needs_followup')  THEN 'needs_followup'
      WHEN bool_or(outcome = 'not_confirmed')   THEN 'not_confirmed'
    END AS outcome,
    string_agg(DISTINCT note, E'\n') FILTER (WHERE note IS NOT NULL AND note <> '') AS note,
    -- случай собран автоматически, если исходы по пунктам расходились
    (COUNT(DISTINCT outcome) FILTER (WHERE outcome IS NOT NULL)) > 1 AS conflicting
  FROM grouped
  GROUP BY user_id, survey_id, grp
),
inserted AS (
  INSERT INTO alert_cases (
    id, user_id, survey_id, opened_at, last_alert_at, severity,
    acknowledged_at, acknowledged_by, note, outcome, merged_from_legacy
  )
  SELECT case_id, user_id, survey_id, opened_at, last_alert_at, severity,
         acknowledged_at, acknowledged_by, note, outcome, true
  FROM cases
  RETURNING id, user_id, survey_id, opened_at, last_alert_at
)
UPDATE risk_alerts a
SET case_id = i.id
FROM inserted i
WHERE a.user_id = i.user_id
  AND a.survey_id = i.survey_id
  AND a.at BETWEEN i.opened_at AND i.last_alert_at
  AND a.case_id IS NULL;
