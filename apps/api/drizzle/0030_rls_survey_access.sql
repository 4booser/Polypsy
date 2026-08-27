-- survey_access тоже остался вне RLS.
--
-- Строка здесь говорит «этому человеку назначена эта методика» — то есть
-- содержит и состав отделения, и факт обследования. Тест на полноту покрытия
-- нашёл её сразу же после того, как закрыли три предыдущие таблицы: список
-- растёт, и держать его в голове нельзя.

ALTER TABLE survey_access ENABLE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS survey_access_access ON survey_access;--> statement-breakpoint
CREATE POLICY survey_access_access ON survey_access USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
  -- обследуемый видит свои назначения: по ним строится его список методик
  OR (app_role() = 'user' AND user_id = app_uid())
);
