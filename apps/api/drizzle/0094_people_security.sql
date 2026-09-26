-- Люди и безопасность в техпанели (участок people2, волна 10): второй фактор,
-- вход «от имени», подозрительная активность.
--
-- ═══ Зачем ═══
--
-- Решение заказчика 2026-09-26. Техпанель открывает суперадмину и держателям
-- ops.read / ops.manage то, от чего меняется работа у всех, — и один пароль
-- от такой учётки слишком мало. Суперадмину нужен способ посмотреть, как
-- система выглядит у конкретного человека, не спрашивая у него пароль. И
-- журнал доступа, который никто не читает, пока не случилось, должен сам
-- показывать то, что стоит прочесть.
--
-- ═══ user_second_factor ═══
--
-- Секрет TOTP (RFC 6238) — шифрованным полем, как ФИО: дамп базы не должен
-- раздавать вторые факторы. Строка без confirmed_at — начатая, но не
-- подтверждённая настройка: секрет уже показан человеку, но вход по нему не
-- требуется, пока он не докажет кодом, что приложение настроено. Иначе
-- закрытое на полпути окно запирало бы учётку навсегда.
--
-- last_step — номер 30-секундного шага последнего принятого кода. Код
-- действует три шага (±1 на расхождение часов телефона), и без этой отметки
-- подсмотренный через плечо код входил бы второй раз в ту же минуту.
-- Принимается только шаг строго больше записанного — условием самого UPDATE,
-- как погашение refresh-токена (lib/refresh.ts, claimRotation): два запроса
-- с одним кодом в одну миллисекунду не проходят оба.
--
-- Номер шага — integer: unix/30 перевалит за 2^31 через шестнадцать веков.
--
-- ═══ user_recovery_codes ═══
--
-- Десять одноразовых кодов на случай потерянного телефона. Хранится хэш, не
-- код: коды показываются один раз при включении, и после этого их нет нигде,
-- кроме листка у человека. Использованный код не удаляется, а помечается —
-- «когда и сколько кодов потрачено» спрашивают, разбирая угон.
--
-- ═══ security_policy ═══
--
-- Одна строка настроек: обязателен ли второй фактор суперадминам и
-- держателям ops.read / ops.manage. Отдельной таблицей, а не флагом окружения:
-- включает её человек с ops.manage из техпанели, и «кто и когда включил»
-- должно лежать рядом (updated_by, и строка журнала). CHECK (id = 1) — чтобы
-- вторая строка не появилась даже по ошибке: две политики читались бы как
-- «какая-то из двух».
--
-- ═══ impersonation_sessions ═══
--
-- Вход суперадмина «от имени» другого человека — только чтение, полчаса,
-- с причиной. Токен сам несёт срок и пометку, но строка нужна по двум
-- причинам: «вийти» гасит сессию сразу (скопированный токен не живёт свои
-- полчаса), а подозрительная активность и отчёт «хто переглядав» видят
-- каждую сессию с причиной. Ссылки RESTRICT: это доказательство, и удаление
-- учётки не должно его уносить.
--
-- ═══ suspicious_findings ═══
--
-- Срабатывания правил над журналом (lib/suspicious.ts). fingerprint — ключ
-- «то же самое срабатывание»: проверка идёт раз в пять минут по последним
-- суткам, и одна серия неудачных входов не должна давать новую строку на
-- каждом проходе — она обновляет свою. notified_at — признак «оповещение ещё
-- не отправлено» для соседнего участка оповещений (obs2b): NULL значит
-- «новое», и подключиться к нему можно, не трогая правил.
--
-- ═══ Политики строк ═══
--
-- Каждая новая таблица — сразу с политикой: покрытие RLS ловит таблицу без
-- неё (см. тесты rls*), а боевая роль без политики не увидела бы ни строки.
--
--  • второй фактор и коды восстановления — свои строки и система. Вход и
--    сторож на каждом запросе читают их системным контекстом (до контекста
--    человека роль ещё неизвестна); настройка в «Обліковому записі» идёт
--    контекстом самого человека; сброс чужого фактора суперадмином —
--    системной ролью внутри его запроса (asSystem), а не политикой «суперадмин
--    видит все секреты»: секреты незачем читать никому, даже ему.
--  • политику читают все (сторож на каждом запросе), правит персонал и
--    система — право ops.manage проверяет маршрут.
--  • сессии «от имени» — суперадмин и система: никто другой их не заводит
--    и не читает.
--  • срабатывания — персонал и система: разбирают держатели audit.read, а
--    право проверяет маршрут.
CREATE TABLE IF NOT EXISTS user_second_factor (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc text NOT NULL,
  confirmed_at timestamptz,
  last_step integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_recovery_codes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_recovery_codes_user_idx ON user_recovery_codes (user_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS security_policy (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  mfa_superadmins boolean NOT NULL DEFAULT false,
  mfa_ops boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text REFERENCES users(id) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO security_policy (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id text PRIMARY KEY,
  actor_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  subject_id text NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reason text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS impersonation_sessions_actor_idx ON impersonation_sessions (actor_id, started_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS impersonation_sessions_subject_idx ON impersonation_sessions (subject_id, started_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS suspicious_findings (
  id text PRIMARY KEY,
  rule text NOT NULL,
  fingerprint text NOT NULL,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  actor_email text,
  subject_id text,
  ip text,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  hits integer NOT NULL,
  details jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz,
  resolved_at timestamptz,
  resolved_by text REFERENCES users(id) ON DELETE SET NULL,
  resolution text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS suspicious_findings_fingerprint_idx ON suspicious_findings (fingerprint);
--> statement-breakpoint
-- список «нерозібрані, свежие сверху» — основной вопрос раздела
CREATE INDEX IF NOT EXISTS suspicious_findings_open_idx ON suspicious_findings (resolved_at, window_to);
--> statement-breakpoint
ALTER TABLE user_second_factor ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS user_second_factor_access ON user_second_factor;
--> statement-breakpoint
CREATE POLICY user_second_factor_access ON user_second_factor FOR ALL USING (
  app_role() = 'system' OR user_id = app_uid()
) WITH CHECK (
  app_role() = 'system' OR user_id = app_uid()
);
--> statement-breakpoint
ALTER TABLE user_recovery_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS user_recovery_codes_access ON user_recovery_codes;
--> statement-breakpoint
CREATE POLICY user_recovery_codes_access ON user_recovery_codes FOR ALL USING (
  app_role() = 'system' OR user_id = app_uid()
) WITH CHECK (
  app_role() = 'system' OR user_id = app_uid()
);
--> statement-breakpoint
ALTER TABLE security_policy ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS security_policy_read ON security_policy;
--> statement-breakpoint
CREATE POLICY security_policy_read ON security_policy FOR SELECT USING (true);
--> statement-breakpoint
DROP POLICY IF EXISTS security_policy_write ON security_policy;
--> statement-breakpoint
CREATE POLICY security_policy_write ON security_policy FOR ALL USING (
  app_role() IN ('system', 'superadmin', 'admin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint
ALTER TABLE impersonation_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS impersonation_sessions_access ON impersonation_sessions;
--> statement-breakpoint
CREATE POLICY impersonation_sessions_access ON impersonation_sessions FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
--> statement-breakpoint
ALTER TABLE suspicious_findings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS suspicious_findings_access ON suspicious_findings;
--> statement-breakpoint
CREATE POLICY suspicious_findings_access ON suspicious_findings FOR ALL USING (
  app_role() IN ('system', 'superadmin', 'admin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin', 'admin')
);
