-- Семь таблиц, оставшихся без политик строк.
--
-- Сетка RLS ставилась по клиническим данным: прохождения, ответы, баллы,
-- тревоги, заметки, планы, приёмы — сорок семь политик. Мимо неё прошли
-- таблицы учётного контура, и среди них самая дорогая: users. Там лежат
-- ФИО и дата рождения (шифрованные), email, слепой индекс телефона, сам
-- телефон и хеш пароля. Любой маршрут, забывший скоуп, отдавал их целиком —
-- страховочной сетки под ним не было.
--
-- Отдельно про group_admins: политика rls_admin_sees_survey, на которой
-- держится добрая половина остальных политик, читает именно эту таблицу.
-- Без политик в неё мог писать кто угодно с любым контекстом — то есть
-- вписать себя администратором каждой группы и получить доступ ко всем
-- методикам, прохождениям и заключениям разом. Запись здесь важнее чтения:
-- пары «группа — администратор» сами по себе не секрет, а вот их
-- изменение — это раздача прав.
--
-- Решение по каждой таблице записано перед её политиками: они разные, и
-- одинаковыми им быть нельзя.

/* ── users ──
   Читают: сам человек — свою строку; персонал — всех (см. ниже); система.
   Пишут: сам человек — свою строку и только с ролью 'user'; персонал и
   система — по праву маршрута.

   Почему персоналу видны все строки, а не «свои пациенты». Такую политику
   можно написать (rls_admin_sees_patient существует), но она сузила бы
   доступ не там: сотрудник обязан видеть коллег (справочник специалистов,
   ведущий специалист, участники переписки, автор заключения) и пациента,
   который ещё ничего не проходил, — а функция отвечает только про
   прохождения, назначения и выданные доступы. Политика, ломающая запись на
   приём к новому пациенту, была бы отключена первой же жалобой из
   регистратуры, и вместе с ней ушла бы вся защита этой таблицы. Здесь
   сетка ловит то, что ловится надёжно: контекст без роли (забытый
   requireAuth) и пациента, дотянувшегося до чужих строк. Разграничение
   внутри персонала остаётся за прикладным скоупом.

   WITH CHECK на своей строке — про роль: без него пациент, правя свой
   профиль, мог бы вписать себе role = 'admin' одним UPDATE в обход
   маршрутов. Прикладной код этого не позволяет, но ровно для этого сетка и
   существует. */
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS users_read ON users;
--> statement-breakpoint
CREATE POLICY users_read ON users FOR SELECT USING (
  app_role() IN ('system', 'superadmin', 'admin')
  OR id = app_uid()
);
--> statement-breakpoint
DROP POLICY IF EXISTS users_insert ON users;
--> statement-breakpoint
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (
  -- регистрация идёт системным контекстом, заведение сотрудника — правом
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint
DROP POLICY IF EXISTS users_update ON users;
--> statement-breakpoint
CREATE POLICY users_update ON users FOR UPDATE USING (
  app_role() IN ('system', 'superadmin', 'admin')
  OR id = app_uid()
) WITH CHECK (
  app_role() IN ('system', 'superadmin', 'admin')
  OR (id = app_uid() AND role = 'user')
);
--> statement-breakpoint
DROP POLICY IF EXISTS users_delete ON users;
--> statement-breakpoint
CREATE POLICY users_delete ON users FOR DELETE USING (
  -- учётные записи удаляет только суперадмин и обслуживание; у сотрудника
  -- такого маршрута нет вовсе, и политика это подтверждает
  app_role() IN ('system', 'superadmin')
);
--> statement-breakpoint

/* ── group_admins ──
   Читают: персонал и система; человек видит свои назначения (по ним
   считается зона ответственности в lib/scope.ts).
   Пишут: только суперадмин и система — это раздача прав, см. заголовок. */
ALTER TABLE group_admins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS group_admins_read ON group_admins;
--> statement-breakpoint
CREATE POLICY group_admins_read ON group_admins FOR SELECT USING (
  app_role() IN ('system', 'superadmin', 'admin')
  OR user_id = app_uid()
);
--> statement-breakpoint
DROP POLICY IF EXISTS group_admins_write ON group_admins;
--> statement-breakpoint
CREATE POLICY group_admins_write ON group_admins FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
--> statement-breakpoint

/* ── audit_log ──
   Читают: персонал и система. Уже: право audit.read, и оно выдаётся не
   только суперадмину (разбирать обходы правил может и не суперадмин) —
   значит политика, пускающая одного суперадмина, сделала бы это право
   ложным: маршрут пускает, база отдаёт пустоту. Сетка здесь отвечает за
   грубое: пациент и контекст без роли журнал не читают.
   Пишут: любой контекст — иначе действие пациента не попало бы в журнал.
   Правка и удаление не разрешены НИКОМУ: политик на UPDATE и DELETE нет, и
   это не забывчивость — журнал append-only, его целостность подтверждается
   хэш-цепочкой, а privileges на update/delete сняты в provision.ts.

   audit_chain_head() — та самая цепочка. Голову цепочки читает КАЖДАЯ
   запись в журнал, в том числе из контекста пациента, которому журнал не
   виден. Без обхода политики голова читалась бы как «цепочки нет», seq
   начинался бы с единицы и упирался в уникальный индекс: запись в журнал
   падала бы у всех, кроме персонала. SECURITY DEFINER отдаёт ровно два
   служебных поля — номер и хэш, — и ничего из содержимого записей. */
CREATE OR REPLACE FUNCTION audit_chain_head()
RETURNS TABLE (seq integer, entry_hash text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT a.seq, a.entry_hash
    FROM audit_log a
   WHERE a.seq IS NOT NULL
   ORDER BY a.seq DESC
   LIMIT 1
$$;
--> statement-breakpoint
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS audit_log_read ON audit_log;
--> statement-breakpoint
CREATE POLICY audit_log_read ON audit_log FOR SELECT USING (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint
DROP POLICY IF EXISTS audit_log_insert ON audit_log;
--> statement-breakpoint
CREATE POLICY audit_log_insert ON audit_log FOR INSERT WITH CHECK (
  app_role() IS NOT NULL
);
--> statement-breakpoint

/* ── refresh_tokens ──
   Раньше отсутствие политики здесь объяснялось тем, что вход происходит до
   контекста. Объяснение перестало быть верным: вход, обновление пары и
   выход объявлены системным контекстом явно (routes/auth.ts), потому что
   того же требует политика на users. Значит таблицу можно закрыть.

   Что она закрывает: контекст пациента не читает и не гасит чужие сессии.
   Сами значения не раскрываются и без политики — хранятся sha256 от 256
   случайных бит, — но отзыв чужой сессии это отказ в обслуживании, а
   перечень сессий говорит, кто и с какого времени работает.
   Персоналу строки видны: смена роли гасит сессии сотрудника, и делает это
   тот, у кого есть users.manage, — не обязательно суперадмин. */
ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS refresh_tokens_access ON refresh_tokens;
--> statement-breakpoint
CREATE POLICY refresh_tokens_access ON refresh_tokens FOR ALL USING (
  app_role() IN ('system', 'superadmin', 'admin')
  OR user_id = app_uid()
) WITH CHECK (
  app_role() IN ('system', 'superadmin', 'admin')
  OR user_id = app_uid()
);
--> statement-breakpoint

/* ── login_attempts ──
   Единственный, кто эту таблицу читает и пишет, — защита от перебора на
   входе, а вход теперь системный. Поэтому политика ровно одна: система.
   Содержимое — почта и адрес неудачных попыток, то есть перечень
   существующих учётных записей: список, ради нераскрытия которого на входе
   специально выравнивается время ответа. Отдавать его персоналу через
   таблицу, когда маршрута для этого нет, незачем. */
ALTER TABLE login_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS login_attempts_access ON login_attempts;
--> statement-breakpoint
CREATE POLICY login_attempts_access ON login_attempts FOR ALL USING (
  app_role() = 'system'
) WITH CHECK (
  app_role() = 'system'
);
--> statement-breakpoint

/* ── invites ──
   Приглашение — это право войти в клиническую систему. Читает и заводит их
   персонал (право invites.manage, сужение по группе батареи — в маршруте),
   предъявляет — регистрация, идущая системным контекстом. Пациенту таблица
   не нужна ни на чтение, ни на запись: код он вводит в форму, а проверяет
   его сервер. */
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS invites_access ON invites;
--> statement-breakpoint
CREATE POLICY invites_access ON invites FOR ALL USING (
  app_role() IN ('system', 'superadmin', 'admin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint

/* ── push_tokens ──
   Адрес устройства человека. Свои — себе, рассылка — системе. Персоналу не
   отдаём: отправить уведомление сотрудник может через рассылку, а знать
   адреса устройств пациента ему незачем. */
ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS push_tokens_access ON push_tokens;
--> statement-breakpoint
CREATE POLICY push_tokens_access ON push_tokens FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR user_id = app_uid()
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR user_id = app_uid()
);
--> statement-breakpoint

/* ── saved_views ──
   Сохранённый фильтр рабочего места. Видит владелец и все — если он сам
   пометил вид общим; правит только владелец. Ровно то же правило, что в
   маршруте: здесь оно выражается в SQL без потерь, и потому выражено. */
ALTER TABLE saved_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS saved_views_read ON saved_views;
--> statement-breakpoint
CREATE POLICY saved_views_read ON saved_views FOR SELECT USING (
  app_role() IN ('system', 'superadmin')
  OR owner_id = app_uid()
  OR shared
);
--> statement-breakpoint
DROP POLICY IF EXISTS saved_views_write ON saved_views;
--> statement-breakpoint
CREATE POLICY saved_views_write ON saved_views FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR owner_id = app_uid()
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR owner_id = app_uid()
);
