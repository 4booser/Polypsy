-- Политики, которые ломали боевые пути под ролью приложения (волна 13).
--
-- Сюита ходит в базу владельцем, а владелец политики обходит; эти две
-- поломки нашёл прогон части сюиты под ролью приложения
-- (QUIZZY_TEST_APP_ROLE=1, отдельный шаг CI) и test/appRoleFlows.test.ts.
--
-- ═══ battery_assignments: назначение — по зоне батареи ═══
--
-- Политика battery_assignments (0040) пускала сотрудника к строке, если он
-- уже видит человека: rls_admin_sees_patient(user_id). Для чтения это
-- верно, для записи — нет. Назначение батареи своей группы человеку, которого
-- администратор ещё не видит, — законный и задуманный путь: именно
-- назначение и вводит человека в зону (третье основание в
-- rls_admin_sees_patient и в lib/scope.ts). Но при проверке вставки новой
-- строки ещё нет, функция её не находит, и PostgreSQL отвечал
-- «new row violates row-level security policy for table "battery_assignments"»:
-- 500 на POST /api/batteries/:id/assign в бою. Сюита, которая ходит
-- владельцем базы, этого не видела; batteries.test.ts под ролью приложения
-- падал первым же тестом.
--
-- Образец — выдача методики (survey_access, 0016): там запись решается по
-- зоне методики (rls_admin_sees_survey), и выдача новому человеку проходит.
-- Здесь так же — по зоне батареи: батарея своей группы или батарея без
-- группы (общая для всех сотрудников — так её и проверяет assertBatteryAccess
-- в routes/batteries.ts).
--
-- Чтение: к прежнему «вижу человека» добавлено «это назначение моей
-- батареи» — назначения своей батареи сотрудник видит всегда, в том числе
-- в момент, когда человек попадает в зону ими же.
--
-- Запись: только по зоне батареи. Прежний CHECK совпадал с USING и пускал
-- сотрудника записывать назначение ЧУЖОЙ батареи человеку своей зоны — код
-- этого не делает (assertBatteryAccess), политика теперь тоже не пускает.
-- Пациент своих назначений не пишет: закрытие батареи при сдаче, каскад и
-- приглашение идут системной ролью (lib/submission.ts, lib/cascade.ts,
-- routes/auth.ts), поэтому «своя строка» в CHECK больше не нужна.
--
-- search_path прибит, как у rls_owns_patient_group (0078): SECURITY DEFINER
-- с плавающим путём — дверь для подмены таблицы.

CREATE OR REPLACE FUNCTION rls_admin_sees_battery(bid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM batteries b
    WHERE b.id = bid
      AND (
        b.group_id IS NULL
        OR b.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
      )
  )
$$;
--> statement-breakpoint
DROP POLICY IF EXISTS battery_assignments_access ON battery_assignments;
--> statement-breakpoint
CREATE POLICY battery_assignments_access ON battery_assignments FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR user_id = app_uid()
  OR rls_admin_sees_patient(user_id)
  OR (app_role() = 'admin' AND rls_admin_sees_battery(battery_id))
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_battery(battery_id))
);
--> statement-breakpoint

-- ═══ surveys: зона администратора — по колонкам самой строки ═══
--
-- surveys_read и surveys_write (0016) пускали администратора к методике
-- через rls_admin_sees_survey(id): функция заново ищет методику по
-- идентификатору и смотрит её группу. Для существующей строки это то же
-- самое, что посмотреть группу у неё самой, — но не для новой. INSERT …
-- RETURNING проверяет возвращаемую строку политикой чтения, а функция её
-- ещё не видит: вставка того же оператора в её снимке отсутствует. Под
-- ролью приложения администратор группы не мог ни завести методику
-- (POST /api/surveys), ни сделать копию (…/duplicate): «new row violates
-- row-level security policy for table "surveys"», 500. Суперадмин проходил
-- по первой ветке — поэтому в бою это могло жить незамеченным.
--
-- Теперь условие смотрит на group_id и created_by самой строки:
-- rls_admin_manages_group (0080) — то же «группа под моим управлением», а
-- методика без группы — личный черновик автора, как и прежде. Для
-- существующих строк смысл не меняется; rls_admin_sees_survey остаётся —
-- ею пользуются политики дочерних таблиц (прохождения, тревоги), где
-- методика всегда уже есть.

DROP POLICY IF EXISTS surveys_read ON surveys;
--> statement-breakpoint
CREATE POLICY surveys_read ON surveys FOR SELECT USING (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND (rls_admin_manages_group(group_id) OR (group_id IS NULL AND created_by = app_uid()))
  )
  OR (app_role() = 'user' AND status = 'published')
);
--> statement-breakpoint
DROP POLICY IF EXISTS surveys_write ON surveys;
--> statement-breakpoint
CREATE POLICY surveys_write ON surveys FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND (rls_admin_manages_group(group_id) OR (group_id IS NULL AND created_by = app_uid()))
  )
) WITH CHECK (
  app_role() IN ('system', 'superadmin', 'admin')
);
