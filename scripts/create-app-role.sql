-- Роль приложения для боевого развёртывания: НЕ владелец таблиц, поэтому
-- RLS-политики для неё активны. Применять от суперпользователя БД:
--   psql "$DATABASE_URL" -v app_password='<пароль>' -f scripts/create-app-role.sql
-- затем в DATABASE_URL приложения указать quizzy_app.

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'quizzy_app') THEN
    EXECUTE format('CREATE ROLE quizzy_app LOGIN PASSWORD %L', current_setting('app_password', true));
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO quizzy_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO quizzy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO quizzy_app;

-- журнал дополнительно закрыт и на уровне привилегий: только чтение и вставка
REVOKE UPDATE, DELETE ON audit_log FROM quizzy_app;

-- Журнал миграций — на чтение, как и в provision.ts: техпанель («Перевірки»,
-- «База даних») сверяет применённые миграции с журналом в образе, и без этого
-- права её проверка «Міграції» навсегда висит предупреждением «немає доступу».
-- Скрипт идёт после установки, когда миграции уже прошли; запущенный раньше —
-- не падает, а выдаёт право при следующем прогоне (скрипт повторяем: роль и
-- права заводятся, только если их нет).
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_namespace WHERE nspname = 'drizzle') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA drizzle TO quizzy_app';
    IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON drizzle.__drizzle_migrations TO quizzy_app';
    END IF;
  END IF;
END $$;
