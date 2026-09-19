-- Группы пациентов: «Моя група», «Група ризику», «Вечірня група».
--
-- ═══ Почему имя patient_groups, а не groups ═══
--
-- В схеме уже есть survey_groups, и в коде их зовут просто «группами»:
-- группа МЕТОДИК — это единица разграничения доступа, на неё назначают
-- администраторов (group_admins), от неё считается зона ответственности
-- сотрудника (lib/scope.ts), ею закрыт доступ к прохождениям и тревогам.
-- Назвать новую сущность `groups` значило бы, что в разговоре, в журнале
-- доступа и в чтении SQL слово «группа» перестаёт что-либо означать: две
-- таблицы с одинаковым именем и противоположным смыслом. Ошибка была бы не
-- в опечатке, а в том, что запрос по «группе» молча вернул бы не тех людей.
--
-- Отсюда имена: patient_groups и patient_group_members — в них слово
-- «пациент» стоит первым, и перепутать их с survey_groups нельзя даже
-- бегло. Название таблицы читают чаще, чем комментарий к ней.
--
-- ═══ Что это такое ═══
--
-- Группа пациентов — рабочий список специалиста: он собирает его руками
-- («додати пацієнта»), даёт ему название и собственное описание («опис групи
-- (питання до групи)»), назначает на всю группу методики («Тести Групи») и
-- фильтрует по ней список пациентов (вкладки сверху на экране пациентов).
--
-- Это НЕ единица разграничения доступа: группа пациентов ничего не
-- открывает и не закрывает. Кого специалист вправе видеть, по-прежнему
-- решает зона ответственности (survey_groups + приёмы + прикрепление к
-- отделению) — а группа пациентов лишь раскладывает уже видимых людей по
-- полкам. Поэтому ниже у неё владелец, а не состав администраторов: список
-- собран одним человеком и выражает его клиническое суждение, а не
-- структуру учреждения.

/* ── patient_groups ──
   owner_id — restrict, ровно по той же причине, по которой survey_groups
   держит created_by: уволенный специалист не должен уносить с собой ни
   списки, ни историю назначений, которые через них прошли. Сначала явно
   передаём содержимое, потом закрываем учётную запись.

   Архивирования и удаления у группы пока нет намеренно: в макете их нет, а
   заводить мягкое снятие «на будущее» значило бы завести второе состояние,
   которое никто не умеет ни показать, ни вернуть. */
CREATE TABLE IF NOT EXISTS patient_groups (
  id text PRIMARY KEY,
  title text NOT NULL,
  -- «опис групи (питання до групи)»: зачем группа собрана и что у неё
  -- спрашивают. Отдельное поле, а не заметка в названии — название стоит
  -- вкладкой и обязано быть коротким
  description text,
  -- цвет вкладки: группы различают взглядом, а не чтением
  color text,
  position integer NOT NULL DEFAULT 0,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Экран групп всегда читается порядком «как разложил владелец»: без индекса
-- это сортировка всей таблицы на каждое открытие вкладок
CREATE INDEX IF NOT EXISTS patient_groups_owner_idx ON patient_groups (owner_id, position);
--> statement-breakpoint

/* ── patient_group_members ──
   Состав группы. Пара «группа — человек» ключом: повторное добавление того
   же человека не должно заводить вторую строку и не должно быть ошибкой —
   специалист жмёт «додати пацієнта» второй раз, потому что не помнит, добавил
   ли он его в прошлый вторник.

   Каскад по обеим ссылкам: членство не переживает ни удаления группы, ни
   удаления учётной записи человека. Клинических данных в строке нет — это
   раскладка по полкам, а не запись о человеке; сами назначения, которые
   через группу прошли, остаются в survey_access и удаления группы не
   замечают (см. ниже про via_patient_group_id). */
CREATE TABLE IF NOT EXISTS patient_group_members (
  group_id text NOT NULL REFERENCES patient_groups(id) ON DELETE CASCADE,
  patient_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by text REFERENCES users(id) ON DELETE SET NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, patient_id)
);
--> statement-breakpoint
-- «в каких группах этот человек» — вопрос карты пациента и фильтра вкладок;
-- по первичному ключу он не отвечается, там группа стоит первой
CREATE INDEX IF NOT EXISTS patient_group_members_patient_idx ON patient_group_members (patient_id);
--> statement-breakpoint

/* ── patient_group_surveys ──
   «Тести Групи»: какие методики назначены на группу целиком.

   Таблица нужна отдельно от survey_access, хотя назначение и разворачивается
   в поимённые строки. Без неё список методик группы пришлось бы выводить из
   пересечения назначений её участников — и он начал бы врать в обе стороны:
   методика, выданная всем троим адресно, показалась бы групповой, а
   групповая исчезла бы из списка, стоило одному участнику выбыть. Здесь
   лежит решение специалиста, а в survey_access — его последствия. */
CREATE TABLE IF NOT EXISTS patient_group_surveys (
  group_id text NOT NULL REFERENCES patient_groups(id) ON DELETE CASCADE,
  survey_id text NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  assigned_by text REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  -- срок и число попыток хранятся и здесь: это условия, на которых методика
  -- назначена группе, и по ним выдаётся назначение тому, кто войдёт в
  -- группу. У каждого человека они дальше живут своей жизнью в survey_access
  expires_at timestamptz,
  attempts_allowed integer,
  PRIMARY KEY (group_id, survey_id)
);
--> statement-breakpoint

/* ── survey_access.via_patient_group_id ──
   В карте человека видно, что методика пришла через группу, а не адресно.

   Это не украшение экрана, а условие, на котором вообще снят запрет
   массового назначения (см. докблок assignSurveyToPatientGroup в
   routes/patientGroups.ts). Разбирая через полгода, почему человек прошёл
   методику, которую ему никто лично не назначал, разбирающий обязан
   получить ответ из данных, а не из догадки.

   ON DELETE SET NULL, а не CASCADE: удаление группы не должно отбирать у
   людей выданные назначения. Методика была назначена по-настоящему — срок
   идёт, попытки посчитаны, человек мог начать её проходить; каскад стёр бы
   строку доступа, и пациент посреди прохождения получил бы 404. Пропадает
   только пометка «через какую группу», и это честно: группы больше нет. */
ALTER TABLE survey_access ADD COLUMN IF NOT EXISTS via_patient_group_id text
  REFERENCES patient_groups(id) ON DELETE SET NULL;
--> statement-breakpoint

/* ═══════════ Политики строк ═══════════

   Таблица без политики — дыра, которую видно только проверкой покрытия,
   поэтому политики едут той же миграцией, что и таблицы. Ниже — решение по
   каждой из трёх; одинаковыми им быть нельзя, у них разное содержимое.

   Вспомогательная функция: «эта группа пациентов моя». Читает patient_groups,
   на которой уже висит собственная политика, поэтому SECURITY DEFINER —
   иначе проверка владения зависела бы от того, видна ли владельцу его же
   строка, и первая же правка политики patient_groups молча меняла бы смысл
   двух других. search_path прибит: функция с SECURITY DEFINER без него — это
   приглашение подменить ей таблицу через временную схему. */
CREATE OR REPLACE FUNCTION rls_owns_patient_group(gid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM patient_groups g WHERE g.id = gid AND g.owner_id = app_uid()
  )
$$;
--> statement-breakpoint

/* ── patient_groups ──
   Видит и правит владелец; система и суперадмин — всё.

   Пациенту не видно ничего, и это решение, а не пропуск. Названия групп —
   «Група ризику», «Вечірня група» — суждение специалиста о человеке,
   высказанное в рабочем порядке и не предназначенное человеку. Пациент
   узнаёт не о группе, а о её последствиях: у него появляется назначенная
   методика со сроком, и она приходит к нему через survey_access, у которого
   свои политики.

   Другому сотруднику тоже не видно, и это стоит сказать вслух: чужой
   рабочий список — не секрет, но и не справочник. Общий на отделение список
   пациентов в системе уже есть (прикрепление к отделению), и он выражает
   структуру учреждения; здесь же лежит личная раскладка, которую второй
   специалист прочитал бы как официальную. Если понадобится общий список,
   его заводят явным полем «общая», как это сделано у saved_views, — а не
   тем, что политику однажды забыли сузить.

   WITH CHECK с тем же условием — про подмену владельца: без него сотрудник
   мог бы завести (или перевести правкой) группу на имя коллеги и подложить
   ему в работу список, которого тот не собирал. */
ALTER TABLE patient_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS patient_groups_access ON patient_groups;
--> statement-breakpoint
CREATE POLICY patient_groups_access ON patient_groups FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND owner_id = app_uid())
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND owner_id = app_uid())
);
--> statement-breakpoint

/* ── patient_group_members ──
   Два условия И, и ни одно не лишнее.

   `rls_owns_patient_group(group_id)` — группа моя. Без него сотрудник,
   которому виден пациент, мог бы дописать его в чужую группу: состав чужого
   рабочего списка изменился бы без ведома того, кто его собирал, и на
   следующем назначении «на всю группу» методику получил бы человек, которого
   в список никто не клал.

   `rls_admin_sees_patient(patient_id)` — человек в моей зоне. Без него
   владение собственной группой превращалось бы в способ читать имена кого
   угодно: добавил чужого пациента по идентификатору — и получил его в
   составе, а с ним ФИО и почту. Именно эту дыру прикладной код закрывает
   assertPatientAccess; политика повторяет правило в SQL, потому что здесь
   оно выражается без потерь.

   Пациенту собственное членство не видно — по той же причине, что и сама
   группа: «вы в группе риска» он не должен узнавать от API. */
ALTER TABLE patient_group_members ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS patient_group_members_access ON patient_group_members;
--> statement-breakpoint
CREATE POLICY patient_group_members_access ON patient_group_members FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND rls_owns_patient_group(group_id)
    AND rls_admin_sees_patient(patient_id)
  )
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND rls_owns_patient_group(group_id)
    AND rls_admin_sees_patient(patient_id)
  )
);
--> statement-breakpoint

/* ── patient_group_surveys ──
   Тоже два условия И: группа моя И методика в моей зоне ответственности.

   Второе — не формальность. Назначение методики на группу раздаёт доступ к
   ней сразу нескольким людям; без проверки методики собственная группа
   пациентов стала бы обходным путём к чужой методике — «своих» людей у
   сотрудника хватает, а `rls_admin_sees_survey` — ровно та функция, которой
   закрыт прямой путь. Один и тот же вопрос обязан иметь один ответ, каким
   бы маршрутом к нему ни шли. */
ALTER TABLE patient_group_surveys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS patient_group_surveys_access ON patient_group_surveys;
--> statement-breakpoint
CREATE POLICY patient_group_surveys_access ON patient_group_surveys FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND rls_owns_patient_group(group_id)
    AND rls_admin_sees_survey(survey_id)
  )
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (
    app_role() = 'admin'
    AND rls_owns_patient_group(group_id)
    AND rls_admin_sees_survey(survey_id)
  )
);
