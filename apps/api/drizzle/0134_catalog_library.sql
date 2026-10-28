-- Общий каталог методик — библиотека всех сотрудников (участок dp-access).
--
-- ═══ Что было ═══
--
-- Методики каталога стоят в группе 'catalog' (lib/catalogInstall.ts), и
-- политики считали её обычной группой: методику и её прохождения видел
-- только администратор группы (rls_admin_survey_ids, rls_admin_sees_survey,
-- surveys_read). Врач без этой группы не видел ни одного результата каталога
-- — на стенде, похожем на бой, у каждого из ста двадцати пациентов «замеров
-- нет». Врачей назначали администраторами каталога руками, и это давало им
-- правку выверенных методик, а через rls_admin_sees_patient — каждого, кто
-- когда-либо проходил любую методику каталога, из любого отделения.
--
-- ═══ Что стало — то же правило, что в lib/scope.ts ═══
--
-- 1. Пользоваться методикой библиотеки может каждый сотрудник: surveys_read
--    пускает администратора к строке методики группы 'catalog', а
--    survey_folders_library_read — к её полкам. Править — по-прежнему только
--    суперадмин и администраторы группы: surveys_write и
--    survey_folders_access не меняются.
--
-- 2. Результаты библиотеки — только о людях зоны сотрудника и о нём самом:
--    прохождение (а с ним ответы, баллы, события ответов и заключения — они
--    видны, когда видно прохождение, 0120), тревога, случай, срабатывание
--    правила, назначение методики, окно повтора видны администратору, если
--    методика в библиотеке и rls_admin_sees_patient(человек). Анонимное
--    прохождение библиотеки (человека нет) администратору не видно.
--
-- 3. Библиотека зону не расширяет: из путей rls_admin_sees_patient «выдана,
--    пройдена, назначен набор группы» группа 'catalog' исключена, и строки
--    group_admins администраторов каталога ничего, кроме правки, не
--    открывают. Им результаты каталога видны по тому же правилу, что всем:
--    rls_admin_survey_ids и rls_admin_sees_survey («все прохождения
--    методики») библиотеку больше не включают.
--
-- 4. Назначения общего набора (без группы — так стоят заготовки каталога) и
--    набора группы 'catalog' видны только о людях зоны: прежде их видел
--    любой сотрудник (rls_admin_sees_battery пускает к общему набору), и с
--    библиотекой, которой пользуются все отделения, список назначений
--    заготовки называл бы пациентов чужих отделений. Назначение набора своей
--    группы видно по-прежнему всегда (rls_admin_owns_battery): оно и вводит
--    человека в зону. Писать назначение общего набора можно по-прежнему —
--    CHECK не меняется; человек при этом обязан уже быть в зоне (маршрут).
--
-- 5. response_facts — с security_invoker: представление читалось правами
--    владельца, то есть мимо политик строк, и длинная выгрузка
--    (routes/spss.ts) держалась на одной проверке маршрута.
--
-- Группа библиотеки названа здесь тем же идентификатором, что
-- CATALOG_GROUP_ID в lib/scope.ts, и только в одной функции —
-- rls_library_group. Сверяет их test/catalogLibrary.test.ts.
--
-- Скорость (#185): методики — множествами, как в 0120 (hashed SubPlan, роль —
-- InitPlan); вызов rls_admin_sees_patient на строку — только у строк
-- библиотеки, после проверки множества: своя методика отвечает раньше, и
-- прохождения своих групп считаются так же, как до правки. Все функции —
-- PARALLEL SAFE, с прибитым search_path.
--
-- Идемпотентно: функции — CREATE OR REPLACE, политики — DROP IF EXISTS и
-- CREATE, правка описания группы — только прежнего текста установщика.

/* ── библиотека ── */

CREATE OR REPLACE FUNCTION rls_library_group(gid text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT gid = 'catalog'
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rls_library_survey_ids() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT s.id FROM surveys s WHERE rls_library_group(s.group_id)
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rls_library_survey(sid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM surveys s WHERE s.id = sid AND rls_library_group(s.group_id))
$$;
--> statement-breakpoint

/* ── «все прохождения методики» — свои группы без библиотеки и свои без группы ── */

CREATE OR REPLACE FUNCTION rls_admin_survey_ids() RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT s.id FROM surveys s
  WHERE (s.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
         AND NOT rls_library_group(s.group_id))
     OR (s.group_id IS NULL AND s.created_by = app_uid())
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION rls_admin_sees_survey(sid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM surveys s
    WHERE s.id = sid
      AND (
        (s.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
         AND NOT rls_library_group(s.group_id))
        OR (s.group_id IS NULL AND s.created_by = app_uid())
      )
  )
$$;
--> statement-breakpoint

/*
 * ── зона: пути через группы — без библиотеки ──
 *
 * Пути — те же, порядок другой: сначала отделение и свой приём. У строк
 * библиотеки функция зовётся на строку, и человек врача чаще всего в зоне
 * именно отделением: OR останавливается на первом истинном, и прохождения
 * своих людей проверяются двумя поисками по ключу вместо пяти. На стенде
 * (120 человек, 1,8 тыс. прохождений) счёт прохождений врачом — 36 мс
 * против 85 при прежнем порядке.
 */
CREATE OR REPLACE FUNCTION rls_admin_sees_patient(uid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  select exists (
    select 1 from department_patients dp
    join specialist_profiles sp on sp.department_id = dp.department_id
    where dp.patient_id = uid and dp.detached_at is null and sp.user_id = app_uid()
  ) or exists (
    select 1 from appointments a
    where a.patient_id = uid and a.specialist_id = app_uid()
  ) or exists (
    select 1 from survey_access sa join surveys s on s.id = sa.survey_id
    where sa.user_id = uid
      and s.group_id in (select ga.group_id from group_admins ga where ga.user_id = app_uid())
      and not rls_library_group(s.group_id)
  ) or exists (
    select 1 from responses r join surveys s on s.id = r.survey_id
    where r.user_id = uid
      and s.group_id in (select ga.group_id from group_admins ga where ga.user_id = app_uid())
      and not rls_library_group(s.group_id)
  ) or exists (
    select 1 from battery_assignments ba join batteries b on b.id = ba.battery_id
    where ba.user_id = uid
      and b.group_id in (select ga.group_id from group_admins ga where ga.user_id = app_uid())
      and not rls_library_group(b.group_id)
  )
$$;
--> statement-breakpoint

/* набор своей группы (не библиотеки): его назначения видны всегда — они и вводят человека в зону */
CREATE OR REPLACE FUNCTION rls_admin_owns_battery(bid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM batteries b
    WHERE b.id = bid
      AND b.group_id IN (SELECT ga.group_id FROM group_admins ga WHERE ga.user_id = app_uid())
      AND NOT rls_library_group(b.group_id)
  )
$$;
--> statement-breakpoint

/* ── методика: пользоваться библиотекой может каждый сотрудник, править — как прежде ── */

DROP POLICY IF EXISTS surveys_read ON surveys;
--> statement-breakpoint
CREATE POLICY surveys_read ON surveys FOR SELECT USING (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND (
      rls_admin_manages_group(group_id)
      OR (group_id IS NULL AND created_by = app_uid())
      OR rls_library_group(group_id)
    )
  )
  OR (app_role() = 'user' AND status = 'published')
);
--> statement-breakpoint

/*
 * Полки библиотеки — читать каждому сотруднику: методика каталога, которую
 * его администраторы положили в папку, иначе пропала бы из корня каталога у
 * всех остальных. Политика только на чтение и складывается с прежней
 * (survey_folders_access, 0080): заводить, править и удалять папки группы —
 * по-прежнему тем, кто группой управляет.
 */
DROP POLICY IF EXISTS survey_folders_library_read ON survey_folders;
--> statement-breakpoint
CREATE POLICY survey_folders_library_read ON survey_folders FOR SELECT USING (
  app_role() = 'admin' AND rls_library_group(group_id)
);
--> statement-breakpoint

/* ── прохождения: своя методика — все, библиотека — сам сотрудник и люди его зоны ── */

DROP POLICY IF EXISTS responses_access ON responses;
--> statement-breakpoint
CREATE POLICY responses_access ON responses FOR ALL USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND (
    survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id))
    OR (survey_id IN (SELECT s.id FROM rls_library_survey_ids() s(id))
        AND (user_id = (SELECT app_uid()) OR rls_admin_sees_patient(user_id)))
  ))
  OR ((SELECT app_role()) = 'user' AND user_id = (SELECT app_uid()))
) WITH CHECK (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND (
    survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id))
    OR (survey_id IN (SELECT s.id FROM rls_library_survey_ids() s(id))
        AND (user_id = (SELECT app_uid()) OR rls_admin_sees_patient(user_id)))
  ))
  -- пациент пишет только свои прохождения; null — анонимные методики
  OR ((SELECT app_role()) = 'user' AND (user_id = (SELECT app_uid()) OR user_id IS NULL))
);
--> statement-breakpoint

/* ── тревоги и случаи — тем же правилом, человек — их собственный ── */

DROP POLICY IF EXISTS risk_alerts_access ON risk_alerts;
--> statement-breakpoint
CREATE POLICY risk_alerts_access ON risk_alerts FOR ALL USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND (
    survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id))
    OR (survey_id IN (SELECT s.id FROM rls_library_survey_ids() s(id)) AND rls_admin_sees_patient(user_id))
  ))
) WITH CHECK (
  app_role() IS NOT NULL
);
--> statement-breakpoint

DROP POLICY IF EXISTS alert_cases_access ON alert_cases;
--> statement-breakpoint
CREATE POLICY alert_cases_access ON alert_cases USING (
  (SELECT app_role()) IN ('system', 'superadmin')
  OR ((SELECT app_role()) = 'admin' AND (
    survey_id IN (SELECT s.id FROM rls_admin_survey_ids() s(id))
    OR (survey_id IN (SELECT s.id FROM rls_library_survey_ids() s(id)) AND rls_admin_sees_patient(user_id))
  ))
);
--> statement-breakpoint

DROP POLICY IF EXISTS rule_hits_access ON rule_hits;
--> statement-breakpoint
CREATE POLICY rule_hits_access ON rule_hits USING (
  app_role() IN ('system', 'superadmin')
  OR rls_admin_sees_survey(survey_id)
  OR (app_role() = 'admin' AND rls_library_survey(survey_id) AND rls_admin_sees_patient(user_id))
);
--> statement-breakpoint

/* ── назначения методик и окна повторов — тем же правилом ── */

DROP POLICY IF EXISTS survey_access_access ON survey_access;
--> statement-breakpoint
CREATE POLICY survey_access_access ON survey_access USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
  OR (app_role() = 'admin' AND rls_library_survey(survey_id) AND rls_admin_sees_patient(user_id))
  OR (app_role() = 'user' AND user_id = app_uid())
);
--> statement-breakpoint

DROP POLICY IF EXISTS survey_followups_access ON survey_followups;
--> statement-breakpoint
CREATE POLICY survey_followups_access ON survey_followups USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
  OR (app_role() = 'admin' AND rls_library_survey(survey_id) AND rls_admin_sees_patient(user_id))
);
--> statement-breakpoint

/* методика в группе пациентов — та, которой владелец группы пользуется: своя или библиотека */
DROP POLICY IF EXISTS patient_group_surveys_access ON patient_group_surveys;
--> statement-breakpoint
CREATE POLICY patient_group_surveys_access ON patient_group_surveys FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND rls_owns_patient_group(group_id)
    AND (rls_admin_sees_survey(survey_id) OR rls_library_survey(survey_id))
  )
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND rls_owns_patient_group(group_id)
    AND (rls_admin_sees_survey(survey_id) OR rls_library_survey(survey_id))
  )
);
--> statement-breakpoint

/* ── назначения наборов: общий набор и набор библиотеки — только о людях зоны ── */

DROP POLICY IF EXISTS battery_assignments_access ON battery_assignments;
--> statement-breakpoint
CREATE POLICY battery_assignments_access ON battery_assignments FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR user_id = app_uid()
  OR rls_admin_sees_patient(user_id)
  OR (app_role() = 'admin' AND rls_admin_owns_battery(battery_id))
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_battery(battery_id))
);
--> statement-breakpoint

/* ── витрина прохождений — под политиками того, кто читает ── */

ALTER VIEW response_facts SET (security_invoker = true);
--> statement-breakpoint

/*
 * Описание группы каталога, которое ставил установщик: «врач видит и
 * назначает их, когда он администратор этой группы». Теперь это неправда —
 * и совет, следуя которому врачу дали бы правку каталога. Меняется только
 * прежний текст установщика: правку учреждения выкат не трогает.
 */
UPDATE survey_groups
SET description = 'Загальний каталог методик: ним користуються всі фахівці, кожен бачить результати лише своїх пацієнтів. Змінюють методики адміністратори групи.'
WHERE id = 'catalog'
  AND description = 'Методики спільного каталогу. Лікар бачить і призначає їх, коли він адміністратор цієї групи.';
