-- RLS для таблиц, заведённых после первого прохода политик.
--
-- alert_cases, referrals и conclusions держат клинические данные и остались
-- вне страховочной сетки: политики писались один раз, а таблицы добавлялись
-- позже. Именно от такой забывчивости RLS и защищает — «второй пояс на
-- случай забытого assertSurveyAccess», — и то, что сам пояс оказался
-- дырявым, обесценивало его целиком.
--
-- Логика зеркалит lib/scope.ts, как и остальные политики.

/* ── случаи риска ── */
ALTER TABLE alert_cases ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS alert_cases_access ON alert_cases;--> statement-breakpoint
CREATE POLICY alert_cases_access ON alert_cases USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
);--> statement-breakpoint

/* ── направления ──
   Направление привязано к человеку, а не к методике: доступ определяется
   тем, виден ли администратору сам обследуемый — то есть соприкасался ли он
   с методиками его групп. Это то же правило, по которому строится список
   пациентов. */
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE OR REPLACE FUNCTION rls_admin_sees_patient(uid text) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM survey_access sa JOIN surveys s ON s.id = sa.survey_id
    WHERE sa.user_id = uid
      AND s.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
  ) OR EXISTS (
    SELECT 1 FROM responses r JOIN surveys s ON s.id = r.survey_id
    WHERE r.user_id = uid
      AND s.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
  ) OR EXISTS (
    SELECT 1 FROM battery_assignments ba JOIN batteries b ON b.id = ba.battery_id
    WHERE ba.user_id = uid
      AND b.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
  )
$$ LANGUAGE sql STABLE SECURITY DEFINER;--> statement-breakpoint

DROP POLICY IF EXISTS referrals_access ON referrals;--> statement-breakpoint
CREATE POLICY referrals_access ON referrals USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_patient(user_id))
  -- обследуемый своих направлений не видит: это переписка специалистов о нём,
  -- и показывать её без разбора врача нельзя
);--> statement-breakpoint

/* ── заключения ──
   Заключение принадлежит прохождению, поэтому доступ наследуется от него.
   Обследуемый видит своё: подписанное заключение попадает в его отчёт. */
ALTER TABLE conclusions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS conclusions_access ON conclusions;--> statement-breakpoint
CREATE POLICY conclusions_access ON conclusions USING (
  app_role() IN ('system', 'superadmin')
  OR EXISTS (
    SELECT 1 FROM responses r
    WHERE r.id = conclusions.response_id
      AND (
        (app_role() = 'admin' AND rls_admin_sees_survey(r.survey_id))
        OR (app_role() = 'user' AND r.user_id = app_uid())
      )
  )
);
