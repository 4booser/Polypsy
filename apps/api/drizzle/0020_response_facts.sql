-- Витрина фактов (8.1): один плоский слой для аналитики второго порядка.
--
-- Аналитика этапов 5–7 иначе гоняет по 4–6 JOIN-ов на каждый срез, причём
-- одни и те же: прохождение × страта × шкала × балл. Витрина считает это
-- один раз, а срезы читают готовое.
--
-- Обычное представление, не материализованное: у нас RLS, а materialized
-- view его не наследует — чтение через него обошло бы политики. Здесь же
-- политики базовых таблиц продолжают действовать, а выигрыш даёт то, что
-- соединение написано один раз и покрыто индексами.
--
-- Снэпшоты страт берутся из responses (волна 1): пол и возраст на МОМЕНТ
-- сдачи, а не текущие, и не требуют расшифровки даты рождения.

CREATE OR REPLACE VIEW response_facts AS
SELECT
  r.id                AS response_id,
  r.survey_id,
  r.version_id,
  r.user_id,
  r.status,
  r.submitted_at,
  to_char(date_trunc('week', r.submitted_at), 'YYYY-MM-DD') AS submitted_week,
  to_char(r.submitted_at, 'YYYY-MM')                        AS submitted_month,
  r.duration_ms,
  r.lang,
  r.respondent_sex,
  r.respondent_age_band,
  u.unit,
  s.scale_id,
  sc.code             AS scale_code,
  sc.kind             AS scale_kind,
  sc.normalization,
  s.raw_score,
  s.value,
  s.max_score,
  s.percent,
  s.band_label,
  s.severity,
  -- «случай высокого риска» — единое определение для всех срезов: раньше
  -- каждый маршрут решал это сам, и определения могли разъехаться
  (s.severity IN ('moderate', 'severe')) AS is_risk
FROM responses r
JOIN response_scores s ON s.response_id = r.id
JOIN scales sc         ON sc.id = s.scale_id
LEFT JOIN users u      ON u.id = r.user_id;
