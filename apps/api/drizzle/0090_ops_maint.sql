-- Техпанель, эксплуатация: объявления о состоянии системы, флаги функций,
-- история выкаток.
--
-- ═══ Что это такое ═══
--
-- Решение заказчика 2026-09-26 (техпанель /ops, пункты 8, 10, 11, 12):
-- режим обслуживания одной кнопкой, страница статуса для сотрудников, флаги
-- функций для отдельных людей и групп без выкатки, история выкаток с
-- откатом на предыдущий тег.
--
-- ═══ Почему в базе, а не в памяти процесса ═══
--
-- Режим обслуживания обязан пережить перезапуск и действовать на всех
-- процессах сразу. Флажок в памяти гас бы ровно в тот момент, ради которого
-- его включали: работы — это чаще всего и есть перезапуск. Второй процесс
-- API (или тот же после рестарта) пускал бы запись, пока первый её режет.
--
-- ═══ service_announcements — история, а не одна строка ═══
--
-- Текущее состояние — последняя строка, а не отдельная запись «сейчас».
-- Каждое включение, выключение и объявление ложится новой строкой и не
-- правится: страница статуса показывает «что было», техпанель — «кто и
-- когда». Строка «сейчас», которую переписывают, историю теряла бы на
-- каждом переключении, а журнал доступа отвечает за действие, но не
-- показывается людям на странице статуса.
--
-- Автор — ссылкой на учётную запись с SET NULL: объявление остаётся в
-- истории и тогда, когда учётку закрыли.
CREATE TABLE IF NOT EXISTS service_announcements (
  id text PRIMARY KEY,
  status text NOT NULL,
  message text,
  expected_end timestamptz,
  created_by text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE service_announcements DROP CONSTRAINT IF EXISTS service_announcements_status_check;
--> statement-breakpoint
-- значение вне трёх означало бы баннер с ключом словаря вместо слов
ALTER TABLE service_announcements ADD CONSTRAINT service_announcements_status_check
  CHECK (status IN ('ok', 'maintenance', 'degraded'));
--> statement-breakpoint
-- «последнее объявление» спрашивается на каждую запись, пока кэш холодный
CREATE INDEX IF NOT EXISTS service_announcements_at_idx ON service_announcements (created_at DESC);
--> statement-breakpoint

/* ── feature_flags ──
   Состояние флага: главный выключатель и аудитория. Сам перечень ключей
   живёт в коде (packages/shared/src/featureFlags.ts): код ссылается на
   типизированный ключ, а не на строку. Строка появляется при первой правке
   флага из техпанели; нет строки — флаг выключен для всех.

   audience — jsonb, а не шесть колонок-массивов: читается и пишется только
   целиком (экран сохраняет форму одной кнопкой), форма проверяется zod на
   входе (featureFlagAudienceSchema), а шесть колонок пришлось бы расширять
   миграцией на каждый новый разрез.

   description — описание из реестра на момент правки: когда ключ из кода
   уберут, строка останется в таблице, и по описанию будет понятно, чем она
   была. */
CREATE TABLE IF NOT EXISTS feature_flags (
  key text PRIMARY KEY,
  description text,
  enabled boolean NOT NULL DEFAULT false,
  audience jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

/* ── feature_flag_changes ──
   Журнал изменений флага: что было и что стало, целиком. Отдельно от
   audit_log не из недоверия к нему: журнал доступа закрыт правом
   audit.read, а смотреть историю флагов положено тому, кто смотрит сами
   флаги (ops.read). Строка в audit_log при этом пишется тоже — это
   действие, меняющее работу системы для людей. */
CREATE TABLE IF NOT EXISTS feature_flag_changes (
  id text PRIMARY KEY,
  flag_key text NOT NULL,
  before jsonb,
  after jsonb NOT NULL,
  changed_by text REFERENCES users(id) ON DELETE SET NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feature_flag_changes_at_idx ON feature_flag_changes (changed_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feature_flag_changes_key_idx ON feature_flag_changes (flag_key, changed_at DESC);
--> statement-breakpoint

/* ── releases ──
   Одна строка на запуск новой версии. Пишет её сам API при старте
   (lib/releases.ts), если версия или коммит отличаются от последней
   строки: перезапуск той же версии дубля не даёт, а откат на прежний тег —
   даёт, потому что это новый выпуск в работе, пусть и со старым именем.

   Версия, коммит, автор и ссылка на прогон приходят из окружения
   контейнера (QUIZZY_VERSION, QUIZZY_COMMIT, QUIZZY_DEPLOYED_BY,
   QUIZZY_RUN_URL, QUIZZY_REPO — их пишет deploy.yml в .env.docker, а
   docker-compose.yml передаёт в контейнер).

   migrations — теги миграций, применённых с прошлого выпуска; NULL —
   неизвестно (первая записанная строка: что было до неё, таблица не
   знает). last_migration — последняя миграция этой версии: от неё
   считается следующая строка. */
CREATE TABLE IF NOT EXISTS releases (
  id text PRIMARY KEY,
  version text NOT NULL,
  commit_sha text,
  deployed_by text,
  run_url text,
  repo text,
  started_at timestamptz NOT NULL DEFAULT now(),
  migrations jsonb,
  last_migration text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS releases_started_idx ON releases (started_at DESC);
--> statement-breakpoint

/* ═══════════ Политики строк ═══════════

   Таблица без политики — дыра, которую видно только проверкой покрытия,
   поэтому политики едут той же миграцией, что и таблицы.

   Читать — персонал (system, superadmin, admin). Право ops.read/ops.manage
   политика не видит — справочник прав живёт в коде, — и различает его
   маршрут (requirePermission). Политика держит второй рубеж: пациенту
   (роль user) не видно ничего. Ему незачем знать, кому включён какой флаг
   и кто объявлял работы; то, что ему положено (текущее состояние, свои
   флаги), сервер отдаёт системным чтением через свои маршруты.

   Писать — персонал только от своего имени (created_by / updated_by /
   changed_by = app_uid()), система — любое. Без этого условия сотрудник
   мог бы объявить работы или переключить флаг от имени коллеги.

   Правки и удаления объявлений, истории флагов и выкаток не разрешены
   никому: это история, и она не переписывается. У feature_flags есть
   UPDATE (выключатель и аудитория меняются на месте, прошлое — в
   feature_flag_changes), но нет DELETE. */
ALTER TABLE service_announcements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS service_announcements_read ON service_announcements;
--> statement-breakpoint
CREATE POLICY service_announcements_read ON service_announcements FOR SELECT USING (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint
DROP POLICY IF EXISTS service_announcements_insert ON service_announcements;
--> statement-breakpoint
CREATE POLICY service_announcements_insert ON service_announcements FOR INSERT WITH CHECK (
  app_role() = 'system'
  OR (app_role() IN ('superadmin', 'admin') AND created_by = app_uid())
);
--> statement-breakpoint

ALTER TABLE feature_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS feature_flags_read ON feature_flags;
--> statement-breakpoint
CREATE POLICY feature_flags_read ON feature_flags FOR SELECT USING (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint
DROP POLICY IF EXISTS feature_flags_insert ON feature_flags;
--> statement-breakpoint
CREATE POLICY feature_flags_insert ON feature_flags FOR INSERT WITH CHECK (
  app_role() = 'system'
  OR (app_role() IN ('superadmin', 'admin') AND updated_by = app_uid())
);
--> statement-breakpoint
DROP POLICY IF EXISTS feature_flags_update ON feature_flags;
--> statement-breakpoint
CREATE POLICY feature_flags_update ON feature_flags FOR UPDATE USING (
  app_role() IN ('system', 'superadmin', 'admin')
) WITH CHECK (
  app_role() = 'system'
  OR (app_role() IN ('superadmin', 'admin') AND updated_by = app_uid())
);
--> statement-breakpoint

ALTER TABLE feature_flag_changes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS feature_flag_changes_read ON feature_flag_changes;
--> statement-breakpoint
CREATE POLICY feature_flag_changes_read ON feature_flag_changes FOR SELECT USING (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint
DROP POLICY IF EXISTS feature_flag_changes_insert ON feature_flag_changes;
--> statement-breakpoint
CREATE POLICY feature_flag_changes_insert ON feature_flag_changes FOR INSERT WITH CHECK (
  app_role() = 'system'
  OR (app_role() IN ('superadmin', 'admin') AND changed_by = app_uid())
);
--> statement-breakpoint

-- выкатку записывает только сам сервер при старте, человеку вписать её нечем
ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS releases_read ON releases;
--> statement-breakpoint
CREATE POLICY releases_read ON releases FOR SELECT USING (
  app_role() IN ('system', 'superadmin', 'admin')
);
--> statement-breakpoint
DROP POLICY IF EXISTS releases_insert ON releases;
--> statement-breakpoint
CREATE POLICY releases_insert ON releases FOR INSERT WITH CHECK (app_role() = 'system');
