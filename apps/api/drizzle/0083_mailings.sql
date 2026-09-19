-- Рассылки: сообщение-объявление «одному многим» с вариантами ответа.
--
-- ═══ Почему отдельные таблицы, а не столбцы в threads/messages ═══
--
-- Переписка (threads, messages) — разговор ДВОИХ: пара «пациент — его
-- специалист» уникальна (threads_pair_uniq), ответ — свободный текст, и
-- границы канала названы на экране: ответ в рабочее время, это не экстренная
-- связь. Рассылка (кадры f09/f16/f22) — другое: один автор, много
-- получателей, у получателя не поле ввода, а кнопки «Так / Ні / …», и после
-- отправки текст неизменен. Класть это в messages значило бы либо снять
-- уникальность пары (и потерять «один разговор на двоих»), либо заводить по
-- разговору на каждого получателя — сто разговоров ради одного объявления,
-- каждый со своим счётчиком непрочитанного и своей историей. Оба пути
-- ломали бы переписку ради того, что перепиской не является.
--
-- Отсюда имя: mailings, не notices и не broadcasts — на макете это раздел
-- «Повідомлення», а слово «сообщение» в схеме уже занято перепиской
-- (messages); «рассылка» говорит ровно то, что здесь лежит: одно письмо,
-- ушедшее списку.
--
-- ═══ Что это такое ═══
--
-- Название, текст, набор вариантов ответа (может быть пустым — тогда это
-- просто уведомление), адресаты — группа пациентов и/или поимённый список.
-- Жизненный цикл в два состояния: draft → sent. Черновик правится и
-- удаляется; отправленная не правится (получатели отвечали бы на разный
-- текст) и не удаляется (её читали и на неё отвечали) — только скрывается у
-- автора.
--
-- Название и текст шифруются, как текст переписки: тема «Група ризику:
-- анкета настрою» говорит о получателях не меньше, чем письмо. Открытая
-- копия темы в базе ради LIKE-поиска повторила бы ошибку, которой в
-- messages.text_enc намеренно избежали; поиск идёт в приложении после
-- расшифровки — список одного автора мал.

/* ── mailings ──
   author_id — RESTRICT, а не SET NULL: за рассылкой тянутся ответы людей, и
   «кто спрашивал» — часть этого документа так же, как автор заключения.
   Уволенный сначала передаёт содержимое, потом закрывается учётная запись.

   patient_group_id — SET NULL: удаление группы не должно уносить рассылку —
   отправленная уже разослана поимённо (mailing_recipients), черновик
   просто теряет одного из адресатов, и автор увидит это в форме.

   options — jsonb-массив подписей, а не отдельная таблица вариантов.
   Отдельная таблица нужна, когда у варианта есть своя жизнь: балл, ключ,
   ссылки из ответов. Здесь вариант — подпись кнопки, меняется только до
   отправки (вместе с текстом), а ответ ссылается на него номером. Таблица
   ради этого была бы вторым местом, где надо помнить про «после отправки не
   менять».

   status и sent_at — вместе: CHECK держит их согласованными, иначе возможны
   «отправлена без даты» и «черновик с датой отправки», и обе строки выглядят
   рабочими по отдельности. */
CREATE TABLE IF NOT EXISTS mailings (
  id text PRIMARY KEY,
  author_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  title_enc text NOT NULL,
  body_enc text NOT NULL,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent')),
  patient_group_id text REFERENCES patient_groups(id) ON DELETE SET NULL,
  patient_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  hidden_at timestamptz,
  CONSTRAINT mailings_sent_at_matches_status CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
--> statement-breakpoint
-- список автора читается «мои, свежие сверху» на каждое открытие раздела
CREATE INDEX IF NOT EXISTS mailings_author_idx ON mailings (author_id, sent_at);
--> statement-breakpoint

/* ── mailing_recipients ──
   Кому доставлено и что ответил. Заводится при отправке по нынешнему составу
   группы и нынешней зоне видимости автора; у черновика строк нет — адресаты
   до отправки лежат в самой рассылке и могут меняться.

   answer — номер варианта в mailings.options, а не текст: текст после
   отправки неизменен (см. выше), а номер не размножает подписи по строкам и
   не даёт двум «Так» с разными пробелами считаться разными ответами.
   CHECK на неотрицательность здесь; верхнюю границу знает только маршрут —
   в SQL длина jsonb-массива соседней таблицы в CHECK не выражается.

   Каскад по обеим ссылкам: строка получателя — факт доставки и ответ, и вне
   рассылки или человека она ничего не значит. */
CREATE TABLE IF NOT EXISTS mailing_recipients (
  mailing_id text NOT NULL REFERENCES mailings(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  answer integer CHECK (answer IS NULL OR answer >= 0),
  answered_at timestamptz,
  -- ответ и его время ставятся вместе: «ответил, но неизвестно когда» не бывает
  CONSTRAINT mailing_recipients_answer_has_time CHECK ((answer IS NULL) = (answered_at IS NULL)),
  PRIMARY KEY (mailing_id, user_id)
);
--> statement-breakpoint
-- «мои повідомлення» в приложении пациента — по человеку; ключ начинается с рассылки
CREATE INDEX IF NOT EXISTS mailing_recipients_user_idx ON mailing_recipients (user_id, delivered_at);
--> statement-breakpoint

/* ═══════════ Право ═══════════

   Новое право mailings.manage — в роли-шаблоны учреждения (0071). Встроенную
   роль «психолог» править не надо: её состав пересчитывается кодом при старте
   из справочника. Шаблоны же правимы руками (is_builtin = false), и код их
   не трогает — значит право туда кладёт миграция, иначе завтрашний
   специалист не увидит раздела, которым вчера пользовался бы. Все три
   ступени: у всех троих есть messages.write, а рассылка — та же работа с
   людьми, только списком. */
INSERT INTO role_permissions (role_id, permission)
SELECT r, 'mailings.manage' FROM unnest(array['role-specialist', 'role-head', 'role-chief']) r
WHERE EXISTS (SELECT 1 FROM roles WHERE id = r)
ON CONFLICT DO NOTHING;
--> statement-breakpoint

/* ═══════════ Политики строк ═══════════

   Таблица без политики — дыра, которую видно только проверкой покрытия,
   поэтому политики едут той же миграцией, что и таблицы.

   Две вспомогательные функции. Обе SECURITY DEFINER: первая читает
   mailings, вторая — mailing_recipients, и на обеих таблицах висят свои
   политики; без DEFINER ответ зависел бы от того, видна ли спрашивающему
   строка, о которой он спрашивает, и правка одной политики молча меняла бы
   смысл другой. search_path прибит по той же причине, что у
   rls_owns_patient_group (0078). */
CREATE OR REPLACE FUNCTION rls_authored_mailing(mid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM mailings m WHERE m.id = mid AND m.author_id = app_uid())
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION rls_mailing_addressed_to_me(mid text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM mailing_recipients r WHERE r.mailing_id = mid AND r.user_id = app_uid()
  )
$$;
--> statement-breakpoint

/* ── mailings ──
   Автор видит и правит свои; система и суперадмин — всё; получатель видит
   ОТПРАВЛЕННУЮ, адресованную ему, — и только видит.

   Черновик получателю не виден, и это не пропуск: до отправки список
   адресатов — намерение автора, а не факт, и человек не должен узнавать из
   API, что его собираются о чём-то спросить. Получатель узнаёт о рассылке в
   момент, когда у него появляется строка в mailing_recipients.

   Другому сотруднику не видно: рассылка — вопрос одного специалиста своим
   людям, и второй специалист, увидев чужую «анкету настрою для групи
   ризику», прочитал бы её как решение учреждения. Ровно то же правило, что у
   patient_groups.

   WITH CHECK с условием по автору — про подмену: без него сотрудник мог бы
   завести рассылку от имени коллеги, и ответы людей пришли бы тому, кто
   ничего не спрашивал. Пишет только персонал: у получателя на этой таблице
   ни INSERT, ни UPDATE — его ответ живёт в mailing_recipients. */
ALTER TABLE mailings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS mailings_read ON mailings;
--> statement-breakpoint
CREATE POLICY mailings_read ON mailings FOR SELECT USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND author_id = app_uid())
  OR (app_role() = 'user' AND status = 'sent' AND rls_mailing_addressed_to_me(id))
);
--> statement-breakpoint
DROP POLICY IF EXISTS mailings_write ON mailings;
--> statement-breakpoint
CREATE POLICY mailings_write ON mailings FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND author_id = app_uid())
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND author_id = app_uid())
);
--> statement-breakpoint

/* ── mailing_recipients ──
   Три политики, потому что у двух сторон разные права на одну строку.

   Персонал: автор рассылки — всё (заводит строки при отправке, читает
   ответы). Условие по пациенту (rls_admin_sees_patient) сюда НЕ входит, в
   отличие от patient_group_members, и это решение: в строке нет ни имени,
   ни почты — только идентификатор и номер ответа, — а имена читатель
   получает уже из users под её политикой. Сужение состава по нынешней зоне
   видимости — работа маршрута (карточка отдаёт только тех, кого читателю
   положено видеть), и оно там есть.

   Получатель: читает свою строку и правит свою строку — отметку прочтения и
   ответ. WITH CHECK на своей строке — про подмену: без него пациент мог бы
   одним UPDATE переписать user_id и «ответить» за другого. Заводить строки
   получатель не может: адресатов назначает автор, а не тот, кто хочет
   получить письмо. */
ALTER TABLE mailing_recipients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS mailing_recipients_staff ON mailing_recipients;
--> statement-breakpoint
CREATE POLICY mailing_recipients_staff ON mailing_recipients FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_authored_mailing(mailing_id))
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_authored_mailing(mailing_id))
);
--> statement-breakpoint
DROP POLICY IF EXISTS mailing_recipients_self_read ON mailing_recipients;
--> statement-breakpoint
CREATE POLICY mailing_recipients_self_read ON mailing_recipients FOR SELECT USING (
  app_role() = 'user' AND user_id = app_uid()
);
--> statement-breakpoint
DROP POLICY IF EXISTS mailing_recipients_self_update ON mailing_recipients;
--> statement-breakpoint
CREATE POLICY mailing_recipients_self_update ON mailing_recipients FOR UPDATE USING (
  app_role() = 'user' AND user_id = app_uid()
) WITH CHECK (
  app_role() = 'user' AND user_id = app_uid()
);
