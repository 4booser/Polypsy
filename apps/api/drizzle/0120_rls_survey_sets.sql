-- Политики строк прохождений — множеством, а не вызовом на строку (#185).
--
-- ═══ Что было ═══
--
-- responses, risk_alerts и alert_cases пускали администратора условием
-- `app_role() = 'admin' AND rls_admin_sees_survey(survey_id)`, а ответы,
-- баллы, события ответов и заключения — тем же вызовом внутри EXISTS по
-- прохождению. Функция — SECURITY DEFINER, такие PostgreSQL не встраивает:
-- на каждую строку таблицы шёл отдельный запрос к surveys и group_admins.
-- Все функции политик были PARALLEL UNSAFE (по умолчанию), и параллельных
-- планов не было ни у одной роли приложения, даже у system, которой условие
-- не нужно вовсе. Замер на синтетике в 1,44× цели: count(*) по баллам у
-- врача — 10 с против 20 мс у владельца, «Огляд» — 40 с против 6 у
-- суперадмина.
--
-- ═══ Что стало ═══
--
-- 1. rls_admin_survey_ids() отдаёт множество методик администратора — то же
--    правило, что у rls_admin_sees_survey: группа под его управлением или
--    его личная методика без группы. В политике — `survey_id IN (SELECT …)`:
--    множество считается один раз на запрос (hashed SubPlan), а не на
--    строку. Функция вызывается из FROM, а не из списка выборки: функция,
--    отдающая множество, в списке выборки (ProjectSet) в PostgreSQL 16
--    параллельный план запрещает, из FROM — нет.
--
-- 2. Роль и пользователь — `(SELECT app_role())`: InitPlan, одно значение на
--    запрос, а не current_setting на каждую строку.
--
-- 3. Ответы, баллы, события ответов и заключения видны ровно тогда, когда
--    видно их прохождение: `EXISTS (SELECT 1 FROM responses r WHERE r.id =
--    response_id)`, а кому прохождение видно — решает политика responses,
--    которая действует и внутри этого подзапроса. Прежние условия этих
--    таблиц сводились к тому же самому: внутри EXISTS повторялась политика
--    прохождений (администратор — методика его, пациент — прохождение его),
--    а сама политика прохождений накладывалась на подзапрос сверху; у
--    событий ответов условие было шире («своё или методика его»), но
--    политика прохождений сужала его до того же. Видимость не меняется ни
--    для одной роли — это проверяет rlsSurveySets.test.ts на мире с
--    несколькими группами, методиками без группы, анонимными прохождениями
--    и ролями без контекста.
--
--    Форма EXISTS с равенством по ключу выбрана намеренно: из неё
--    планировщик строит оба плана (AlternativeSubPlan) — для массового
--    чтения множество видимых прохождений одной хэш-таблицей, для чтения
--    одного прохождения — проверку по первичному ключу на строку — и
--    выбирает по ожидаемому числу строк. `response_id IN (SELECT …)` дал
--    бы только первый, и чтение одного прохождения строило бы множество
--    всех.
--
-- 4. Функции политик помечены PARALLEL SAFE: они только читают таблицы и
--    настройки app.role/app.user_id. Настройки сеанса PostgreSQL передаёт
--    параллельным исполнителям вместе с остальным состоянием ведущего
--    процесса, current_setting сам по себе PARALLEL SAFE; запрещено менять
--    настройки (PARALLEL UNSAFE «make persistent changes to settings»), а
--    SET search_path у SECURITY DEFINER — это сохранение и откат на время
--    вызова, его исполнителю делать можно. Записей в базу, временных
--    таблиц, курсоров и последовательностей у функций нет.
--
-- rls_admin_sees_survey остаётся: её зовут политики, которых правка не
-- касается (rule_hits, survey_access, survey_followups,
-- patient_group_surveys).

CREATE OR REPLACE FUNCTION rls_admin_survey_ids() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT s.id FROM surveys s
  WHERE s.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
     OR (s.group_id IS NULL AND s.created_by = app_uid())
$$;
--> statement-breakpoint

ALTER FUNCTION app_role() PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION app_uid() PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_admin_sees_survey(text) PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_admin_sees_patient(text) PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_admin_manages_group(text) PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_admin_sees_battery(text) PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_owns_patient_group(text) PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_has_permission(text) PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_authored_mailing(text) PARALLEL SAFE;
--> statement-breakpoint
ALTER FUNCTION rls_mailing_addressed_to_me(text) PARALLEL SAFE;
--> statement-breakpoint

/* ── responses ── */
DROP POLICY IF EXISTS responses_access ON responses;
--> statement-breakpoint
CREATE POLICY responses_access ON responses FOR ALL USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id)))
  OR ((SELECT app_role()) = 'user' AND user_id = (SELECT app_uid()))
) WITH CHECK (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id)))
  -- пациент пишет только свои прохождения; null — анонимные методики
  OR ((SELECT app_role()) = 'user' AND (user_id = (SELECT app_uid()) OR user_id IS NULL))
);
--> statement-breakpoint

/* ── то, что принадлежит прохождению: видно, когда видно прохождение ── */
DROP POLICY IF EXISTS answers_access ON answers;
--> statement-breakpoint
CREATE POLICY answers_access ON answers FOR ALL USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR EXISTS (SELECT 1 FROM responses r WHERE r.id = answers.response_id)
) WITH CHECK (
  app_role() IS NOT NULL
);
--> statement-breakpoint

DROP POLICY IF EXISTS response_scores_access ON response_scores;
--> statement-breakpoint
CREATE POLICY response_scores_access ON response_scores FOR ALL USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR EXISTS (SELECT 1 FROM responses r WHERE r.id = response_scores.response_id)
) WITH CHECK (
  app_role() IS NOT NULL
);
--> statement-breakpoint

DROP POLICY IF EXISTS answer_events_access ON answer_events;
--> statement-breakpoint
CREATE POLICY answer_events_access ON answer_events USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR EXISTS (SELECT 1 FROM responses r WHERE r.id = answer_events.response_id)
);
--> statement-breakpoint

DROP POLICY IF EXISTS conclusions_access ON conclusions;
--> statement-breakpoint
CREATE POLICY conclusions_access ON conclusions USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR EXISTS (SELECT 1 FROM responses r WHERE r.id = conclusions.response_id)
);
--> statement-breakpoint

/* ── тревоги и случаи — по методике ── */
DROP POLICY IF EXISTS risk_alerts_access ON risk_alerts;
--> statement-breakpoint
CREATE POLICY risk_alerts_access ON risk_alerts FOR ALL USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id)))
) WITH CHECK (
  app_role() IS NOT NULL
);
--> statement-breakpoint

DROP POLICY IF EXISTS alert_cases_access ON alert_cases;
--> statement-breakpoint
CREATE POLICY alert_cases_access ON alert_cases USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id)))
);
