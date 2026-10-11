-- Максимум и процент шкал с поправками — от балла после поправок (волна 21,
-- участок clinical, #133).
--
-- Движок считал процент от балла после поправок, а максимум — только по
-- пунктам ключа: у ЛАП МЛО своих пунктов нет (она вся из поправок ПР + КП +
-- МН), и лист печатал «0 з 0 · 0 %» у любого человека; у шкал Мини-мульта с
-- K-поправкой процент уходил за сто (Pt 168,8 %, Se 170 %). Движок теперь
-- прибавляет к максимуму то, что источник поправки может дать по своим
-- пунктам (packages/shared/src/scoring.ts, scaleMaxScore). Здесь — то же для
-- уже записанных строк, иначе лист и карточка прежних протоколов печатали бы
-- прежние числа.
--
-- Пересчитываются только шкалы, максимум которых выводится из определения
-- без движка: свёртка «сумма», ключ — совпадения «так/ні» с неотрицательным
-- весом (вклад пункта — его вес), поправки с неотрицательным коэффициентом
-- от таких же шкал без своих поправок. Это Мини-мульт и МЛО; шкалы
-- конструктора с другой механикой не трогаются. Максимум берётся из
-- определения, а не из записанной строки, поэтому повторный прогон ничего не
-- меняет.
--
-- Балл после поправок у строк до 0118 пуст; он восстанавливается из сырых
-- баллов источников той же сдачи — так же, как его складывает движок
-- (сырой + Σ коэффициент × сырой источника). Строка, у которой балла после
-- поправок нет и источник не записан, не трогается: процент без балла не
-- пересчитать.
--
-- Округление — как у движка (Math.round(x) = floor(x + 0.5) в двойной
-- точности): максимум до сотых, балл после поправок до тысячных, процент до
-- десятых.

WITH scale_max AS (
  SELECT
    s.id AS scale_id,
    s.aggregation,
    coalesce(sum(si.weight), 0) AS raw_max,
    -- у шкалы без пунктов (ЛАП) условие выполнено пусто
    coalesce(bool_and(si.match_key IS NOT NULL AND si.weight >= 0) FILTER (WHERE si.scale_id IS NOT NULL), true) AS keyed,
    EXISTS (SELECT 1 FROM scale_corrections c WHERE c.target_scale_id = s.id) AS corrected
  FROM scales s
  LEFT JOIN scale_items si ON si.scale_id = s.id
  GROUP BY s.id, s.aggregation
),
target AS (
  SELECT
    sc.target_scale_id AS scale_id,
    t.raw_max + sum(sc.coefficient * src.raw_max) AS new_max
  FROM scale_corrections sc
  JOIN scale_max t ON t.scale_id = sc.target_scale_id
  JOIN scale_max src ON src.scale_id = sc.source_scale_id
  GROUP BY sc.target_scale_id, t.raw_max
  HAVING bool_and(
    sc.coefficient >= 0
    AND t.keyed AND t.aggregation = 'sum'
    AND src.keyed AND src.aggregation = 'sum' AND NOT src.corrected
  )
),
fix AS (
  SELECT
    rs.id,
    floor(t.new_max::float8 * 100 + 0.5) / 100 AS new_max,
    coalesce(
      rs.corrected_score,
      CASE WHEN count(src.id) = count(*) THEN floor((rs.raw_score + sum(sc.coefficient * src.raw_score)) * 1000 + 0.5) / 1000 END
    ) AS corrected
  FROM response_scores rs
  JOIN target t ON t.scale_id = rs.scale_id
  JOIN scale_corrections sc ON sc.target_scale_id = rs.scale_id
  LEFT JOIN response_scores src ON src.response_id = rs.response_id AND src.scale_id = sc.source_scale_id
  GROUP BY rs.id, rs.corrected_score, rs.raw_score, t.new_max
)
UPDATE response_scores rs
SET
  max_score = fix.new_max,
  corrected_score = fix.corrected,
  percent = CASE WHEN fix.new_max > 0 THEN floor(fix.corrected / fix.new_max * 1000 + 0.5) / 10 ELSE 0 END
FROM fix
WHERE rs.id = fix.id
  AND fix.corrected IS NOT NULL
  AND (rs.max_score IS DISTINCT FROM fix.new_max OR rs.corrected_score IS NULL);
