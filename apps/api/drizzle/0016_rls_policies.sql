-- RLS: страховочная сетка под прикладным скоупингом (lib/scope.ts).
--
-- Политики читают app.user_id/app.role, которые выставляет транзакционный
-- контекст (src/db/context.ts). Отсутствие контекста = пустые выборки:
-- забытый requireAuth в новом маршруте упирается в ноль строк, а не в чужие
-- данные. Роль 'system' — явные фоновые процессы и публичные конвейеры.
--
-- ВАЖНО: владелец таблиц обходит RLS (это штатно для Postgres). В dev
-- приложение ходит владельцем — политики спят. В бою приложение подключается
-- ролью quizzy_app (см. scripts/create-app-role.sql) — политики активны.
-- Прикладной скоупинг остаётся первым рубежом в обоих случаях.

CREATE OR REPLACE FUNCTION app_role() RETURNS text AS $$
  SELECT nullif(current_setting('app.role', true), '')
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_uid() RETURNS text AS $$
  SELECT nullif(current_setting('app.user_id', true), '')
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

-- админ видит методику: группа под его управлением или его личный черновик
CREATE OR REPLACE FUNCTION rls_admin_sees_survey(sid text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM surveys s
    WHERE s.id = sid
      AND (
        s.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
        OR (s.group_id IS NULL AND s.created_by = app_uid())
      )
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER;
--> statement-breakpoint

/* ── surveys ── */
ALTER TABLE surveys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS surveys_read ON surveys;
--> statement-breakpoint
CREATE POLICY surveys_read ON surveys FOR SELECT USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(id))
  OR (app_role() = 'user' AND status = 'published')
);
--> statement-breakpoint
DROP POLICY IF EXISTS surveys_write ON surveys;
--> statement-breakpoint
CREATE POLICY surveys_write ON surveys FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(id))
) WITH CHECK (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint

/* ── responses ── */
ALTER TABLE responses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS responses_access ON responses;
--> statement-breakpoint
CREATE POLICY responses_access ON responses FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
  OR (app_role() = 'user' AND user_id = app_uid())
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
  -- пациент пишет только свои прохождения; null — анонимные методики
  OR (app_role() = 'user' AND (user_id = app_uid() OR user_id IS NULL))
);
--> statement-breakpoint

/* ── answers ── */
ALTER TABLE answers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS answers_access ON answers;
--> statement-breakpoint
CREATE POLICY answers_access ON answers FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR EXISTS (
    SELECT 1 FROM responses r
    WHERE r.id = response_id
      AND (
        (app_role() = 'admin' AND rls_admin_sees_survey(r.survey_id))
        OR (app_role() = 'user' AND r.user_id = app_uid())
      )
  )
) WITH CHECK (
  app_role() IS NOT NULL
);
--> statement-breakpoint

/* ── response_scores ── */
ALTER TABLE response_scores ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS response_scores_access ON response_scores;
--> statement-breakpoint
CREATE POLICY response_scores_access ON response_scores FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR EXISTS (
    SELECT 1 FROM responses r
    WHERE r.id = response_id
      AND (
        (app_role() = 'admin' AND rls_admin_sees_survey(r.survey_id))
        OR (app_role() = 'user' AND r.user_id = app_uid())
      )
  )
) WITH CHECK (
  app_role() IS NOT NULL
);
--> statement-breakpoint

/* ── risk_alerts ── */
ALTER TABLE risk_alerts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS risk_alerts_access ON risk_alerts;
--> statement-breakpoint
CREATE POLICY risk_alerts_access ON risk_alerts FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
) WITH CHECK (
  app_role() IS NOT NULL
);
