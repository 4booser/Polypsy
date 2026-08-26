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
