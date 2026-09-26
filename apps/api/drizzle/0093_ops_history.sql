-- Техпанель: история логов, ошибок и нагрузки — переживает перезапуск и выкатку.
--
-- ═══ Зачем ═══
--
-- Решение заказчика 2026-09-26: «постоянное хранение логов и ошибок с
-- ротацией». До сих пор память техпанели была кольцевыми буферами процесса
-- (lib/opsBuffer.ts): выкатка стирала всё, и ровно в тот момент, когда
-- нужнее всего спросить «что было до» — после неудачной выкатки, — спросить
-- было некого. Буферы остаются живым хвостом; сюда их содержимое уходит
-- пачками в фоне (lib/opsStore.ts), без записи в базу на каждый запрос.
--
-- ═══ Что здесь лежит — и чего нет ═══
--
-- Три вида записей, и ни в одном нет персональных данных:
--   ops_log_lines       — строки лога после вычистки буфера (поля с именами
--                         и почтой скрыты, телефоны замаскированы);
--   ops_error_groups    — группы ошибок по отпечатку: сообщение без
--   ops_error_hours       значений, кадры стека без путей машины, маршрут
--                         шаблоном; и почасовой счёт случаев каждой группы;
--   ops_request_aggs    — поминутные и почасовые суммы запросов по шаблону
--                         маршрута с меткой версии выкатки (для сравнения
--                         «до и после»).
-- Ни идентификатора человека, ни адреса с идентификатором: маршрут —
-- шаблоном, как в метриках Prometheus. Номер запроса (request_id) — не
-- данные о человеке, а ключ разбора: по нему собирается трасса.
--
-- ═══ Срок хранения ═══
--
-- Сроки — константами в коде (lib/opsStore.ts, там же обоснование каждого):
-- логи 14 дней, ошибки 90, минутные суммы 14, часовые 180. Чистит задача
-- планировщика ops.rotate. Клинического здесь нет, и правило «клиническое
-- не удаляется» к этим таблицам не относится — они и заведены удаляемыми.
--
-- ═══ Кто видит ═══
--
-- Читать — система и держатели права ops.read (техпанель), писать и
-- удалять — только система (фоновая запись и ротация). Право в политике —
-- через rls_has_permission(): ops.read выдаётся личным исключением, а не
-- ролью доступа, и «любой сотрудник» здесь был бы шире маршрута. Функция —
-- зеркало permissionsOf() из lib/permissions.ts; что они не разошлись,
-- сторожит тест apps/api/test/opsObs2a.test.ts.

/* ── право из SQL ──
   Суперадмин — все права (как permissionsOf: роль-ключ, а не набор).
   Пациент — никаких: техпанель закрыта requireStaff, и строка политики не
   должна быть шире маршрута. Остальным — права ролей плюс действующие
   личные выдачи, минус действующие отъёмы: отнятое побеждает добавленное
   независимо от порядка строк. Срок сравнивается в базе, как и в коде.
   SECURITY DEFINER — чтобы вопрос о праве не зависел от политик на самих
   таблицах прав; наружу отдаётся одно «да/нет». */
CREATE OR REPLACE FUNCTION rls_has_permission(perm text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN app_role() = 'superadmin' THEN true
    WHEN app_role() IS DISTINCT FROM 'admin' OR app_uid() IS NULL THEN false
    ELSE NOT EXISTS (
        SELECT 1 FROM permission_exceptions e
        WHERE e.user_id = app_uid() AND e.permission = perm AND e.mode = 'revoke'
          AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now())
      )
      AND (
        EXISTS (
          SELECT 1 FROM staff_roles sr
          JOIN role_permissions rp ON rp.role_id = sr.role_id
          WHERE sr.user_id = app_uid() AND rp.permission = perm
        )
        OR EXISTS (
          SELECT 1 FROM permission_exceptions e
          WHERE e.user_id = app_uid() AND e.permission = perm AND e.mode = 'grant'
            AND e.revoked_at IS NULL AND (e.expires_at IS NULL OR e.expires_at > now())
        )
      )
  END
$$;
--> statement-breakpoint

/* ── строки лога ──
   Ключ — экземпляр процесса и сквозной номер его буфера: живой хвост из
   памяти и история из базы склеиваются по нему без дублей, а повтор
   пачки после обрыва связи (ON CONFLICT DO NOTHING) не рождает копий.
   sql — счёт SQL запроса и самые медленные тексты, только у строки
   «request» медленного, упавшего или тяжёлого запроса: для трассы. */
CREATE TABLE IF NOT EXISTS ops_log_lines (
  instance text NOT NULL,
  seq bigint NOT NULL,
  at timestamptz NOT NULL,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message text NOT NULL,
  request_id text,
  fingerprint text,
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  sql jsonb,
  version text,
  PRIMARY KEY (instance, seq)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_log_lines_at_idx ON ops_log_lines (at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_log_lines_request_idx ON ops_log_lines (request_id) WHERE request_id IS NOT NULL;
--> statement-breakpoint
/* предупреждения и ошибки ищут чаще всего и их на порядки меньше, чем info */
CREATE INDEX IF NOT EXISTS ops_log_lines_loud_idx ON ops_log_lines (at DESC) WHERE level IN ('warn', 'error');
--> statement-breakpoint

/* ── группы ошибок ──
   count — всего с первого раза (в пределах срока хранения группы);
   число за период — сумма по ops_error_hours. */
CREATE TABLE IF NOT EXISTS ops_error_groups (
  fingerprint text PRIMARY KEY,
  origin text NOT NULL,
  name text NOT NULL,
  message text NOT NULL,
  method text,
  route text,
  code integer,
  count bigint NOT NULL DEFAULT 0,
  first_at timestamptz NOT NULL,
  last_at timestamptz NOT NULL,
  last_request_id text,
  frames jsonb NOT NULL DEFAULT '[]'::jsonb,
  first_version text,
  last_version text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_error_groups_last_idx ON ops_error_groups (last_at DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ops_error_hours (
  fingerprint text NOT NULL REFERENCES ops_error_groups (fingerprint) ON DELETE CASCADE,
  hour timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (fingerprint, hour)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_error_hours_hour_idx ON ops_error_hours (hour);
--> statement-breakpoint

/* ── суммы запросов ──
   hist — счётчики по корзинам времени ответа (LATENCY_BUCKETS в
   lib/metrics.ts плюс «выше последней»): перцентили считаются по ним тем же
   способом, что в памяти процесса и в Prometheus. Сумма двух строк —
   поэлементная сумма массивов. */
CREATE TABLE IF NOT EXISTS ops_request_aggs (
  grain text NOT NULL CHECK (grain IN ('minute', 'hour')),
  bucket timestamptz NOT NULL,
  version text NOT NULL,
  method text NOT NULL,
  route text NOT NULL,
  count integer NOT NULL,
  c4 integer NOT NULL,
  c5 integer NOT NULL,
  sum_ms double precision NOT NULL,
  max_ms double precision NOT NULL,
  hist integer[] NOT NULL,
  PRIMARY KEY (grain, bucket, version, method, route)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_request_aggs_version_idx ON ops_request_aggs (grain, version, bucket);
--> statement-breakpoint

/* ── политики строк ── */
ALTER TABLE ops_log_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ops_error_groups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ops_error_hours ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ops_request_aggs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ops_log_lines_read ON ops_log_lines;
--> statement-breakpoint
CREATE POLICY ops_log_lines_read ON ops_log_lines FOR SELECT USING (
  app_role() = 'system' OR rls_has_permission('ops.read')
);
--> statement-breakpoint
DROP POLICY IF EXISTS ops_log_lines_write ON ops_log_lines;
--> statement-breakpoint
CREATE POLICY ops_log_lines_write ON ops_log_lines FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
--> statement-breakpoint
DROP POLICY IF EXISTS ops_error_groups_read ON ops_error_groups;
--> statement-breakpoint
CREATE POLICY ops_error_groups_read ON ops_error_groups FOR SELECT USING (
  app_role() = 'system' OR rls_has_permission('ops.read')
);
--> statement-breakpoint
DROP POLICY IF EXISTS ops_error_groups_write ON ops_error_groups;
--> statement-breakpoint
CREATE POLICY ops_error_groups_write ON ops_error_groups FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
--> statement-breakpoint
DROP POLICY IF EXISTS ops_error_hours_read ON ops_error_hours;
--> statement-breakpoint
CREATE POLICY ops_error_hours_read ON ops_error_hours FOR SELECT USING (
  app_role() = 'system' OR rls_has_permission('ops.read')
);
--> statement-breakpoint
DROP POLICY IF EXISTS ops_error_hours_write ON ops_error_hours;
--> statement-breakpoint
CREATE POLICY ops_error_hours_write ON ops_error_hours FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
--> statement-breakpoint
DROP POLICY IF EXISTS ops_request_aggs_read ON ops_request_aggs;
--> statement-breakpoint
CREATE POLICY ops_request_aggs_read ON ops_request_aggs FOR SELECT USING (
  app_role() = 'system' OR rls_has_permission('ops.read')
);
--> statement-breakpoint
DROP POLICY IF EXISTS ops_request_aggs_write ON ops_request_aggs;
--> statement-breakpoint
CREATE POLICY ops_request_aggs_write ON ops_request_aggs FOR ALL USING (app_role() = 'system') WITH CHECK (app_role() = 'system');
--> statement-breakpoint

/* ── pg_stat_statements ──
   Раздел «Повільні SQL» читает это расширение. Создать его может только
   суперпользователь (в образе postgres из docker-compose.yml им и
   запускается provision — владелец базы quizzy создан POSTGRES_USER), и
   только если пакет расширения есть на сервере. Не можем — миграция НЕ
   падает: раздел честно скажет «не ввімкнено» и как включить. Блок
   EXCEPTION — своя точка сохранения, отказ внутри не обрывает миграцию.

   Само создание ничего не включает: сбор статистики начинается только с
   shared_preload_libraries и перезапуском сервера базы. Этого миграция не
   делает и делать не должна — перезапуск клинической базы решает человек
   (docs/RUNBOOK.md, «Техпанель»). */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_stat_statements')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper) THEN
    CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements не создано: %', SQLERRM;
END
$$;
