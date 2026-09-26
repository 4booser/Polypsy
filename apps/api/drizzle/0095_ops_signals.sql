-- Техпанель, участок obs2b: оповещения, ошибки клиента, скорость экранов.
--
-- ═══ Почему в базе, а не в памяти процесса ═══
--
-- Остальная техпанель (lib/opsBuffer.ts) помнит только с момента запуска —
-- и честно это говорит. Оповещениям так нельзя: инцидент, про который
-- процесс забыл при перезапуске, прислал бы «збій» второй раз и никогда не
-- прислал бы «відновлено». Ошибки клиента и скорость экранов — тоже:
-- p75 за тридцать дней, живущий до перезапуска, — это p75 за вчера.
--
-- ═══ Что НЕ лежит здесь ═══
--
-- Ни одной ссылки на человека. Ошибки клиента — маршрутом-шаблоном
-- (`/patients/:id`), сообщением и стеком, вычищенными на клиенте и ещё раз на
-- сервере; браузер и ОС — грубо. Скорость экранов — числами по корзинам, без
-- сессий и без учёток. Правила и история оповещений — о системе, не о людях.
-- Поэтому проверка покрытия политиками в access.test.ts эти таблицы и не
-- найдёт (нет колонок со ссылкой на пациента) — политики им всё равно
-- положены, см. ниже.

/* ── ops_alert_rules ──
   Правило на сигнал: порог, окно, как часто повторять, куда слать — и
   состояние инцидента. Состояние в той же строке, а не отдельной таблицей:
   правил пять, и у каждого инцидент один — «идёт с такого-то, последнее
   оповещение тогда-то».

   Строки заводятся миграцией: набор сигналов задан кодом (lib/opsAlerts.ts),
   человек правит пороги, а не набор. Умолчания подобраны под установку
   отделения:
     errors5xx      — доля 5xx больше 5 % за 10 минут (при 20+ запросах);
     schedulerSilent — планировщик молчит дольше 130 минут (такт — час,
                       «сбой» на обзоре — после двух тактов);
     p95            — p95 ответа дольше 2 с за 15 минут (при 20+ запросах);
     diskFree       — свободно меньше 10 % на томе записей приёмов;
     auditChain     — последняя проверка цепочки журнала провалилась. */
CREATE TABLE IF NOT EXISTS ops_alert_rules (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  threshold double precision,
  window_min integer,
  repeat_min integer NOT NULL DEFAULT 60,
  channels jsonb NOT NULL DEFAULT '["telegram","email"]'::jsonb,
  firing_since timestamptz,
  last_sent_at timestamptz,
  last_value double precision,
  last_state text,
  last_reason text,
  last_checked_at timestamptz,
  updated_at timestamptz,
  updated_by text REFERENCES users(id) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO ops_alert_rules (key, threshold, window_min, repeat_min) VALUES
  ('errors5xx', 5, 10, 60),
  ('schedulerSilent', 130, NULL, 180),
  ('p95', 2000, 15, 60),
  ('diskFree', 10, NULL, 360),
  ('auditChain', NULL, NULL, 1440)
ON CONFLICT (key) DO NOTHING;
--> statement-breakpoint

/* ── ops_alert_events ──
   История срабатываний: сработало, повтор, восстановлено, тестовое. По
   каждому каналу — ушло, отказ (текстом без токена) или «не настроен».
   Хранится 90 дней: история нужна на разбор недавнего, а не архивом. */
CREATE TABLE IF NOT EXISTS ops_alert_events (
  id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  rule_key text,
  kind text NOT NULL,
  value double precision,
  threshold double precision,
  deliveries jsonb NOT NULL DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_alert_events_at_idx ON ops_alert_events (at DESC);
--> statement-breakpoint

/* ── ops_client_errors ──
   Группа ошибки клиента по отпечатку: платформа, вид, имя, сообщение без
   данных, верхний кадр, маршрут, для сетевых — метод, маршрут API и код.
   Двести одинаковых падений у двухсот человек — одна строка «200 разів». */
CREATE TABLE IF NOT EXISTS ops_client_errors (
  fingerprint text PRIMARY KEY,
  platform text NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  message text NOT NULL,
  route text NOT NULL,
  api_method text,
  api_route text,
  status integer,
  release text,
  browser text,
  os text,
  frames jsonb NOT NULL DEFAULT '[]'::jsonb,
  count integer NOT NULL DEFAULT 0,
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ops_client_errors_last_idx ON ops_client_errors (last_at DESC);
--> statement-breakpoint

/* ── ops_vitals ──
   Скорость экранов: число замеров в корзине за день по маршруту и мере.
   Не замеры поштучно — p75 из корзин считается так же, как перцентили
   нагрузки техпанели, а строк выходит «дни × маршруты × меры × корзины», а
   не «каждый показ каждого экрана». День — по поясу учреждения (lib/day.ts). */
CREATE TABLE IF NOT EXISTS ops_vitals (
  day date NOT NULL,
  route text NOT NULL,
  metric text NOT NULL,
  bucket integer NOT NULL,
  n integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route, metric, bucket)
);
--> statement-breakpoint

/* ═══════════ Политики строк ═══════════

   Всё — системе и суперадмину. Маршруты техпанели читают и пишут эти
   таблицы системным контекстом (asSystem), а кого пускать, решает право
   ops.read / ops.manage на маршруте: разработчик с исключением ops.read —
   администратор по классу записи, и политика «по роли» ему не подходит ни
   так, ни эдак. Приём ошибок клиента без входа — тоже системным контекстом:
   экрана входа нет ни у какой роли. Пустая политика «никому» здесь была бы
   честнее всего, но таблица без политики неотличима от забытой. */
ALTER TABLE ops_alert_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ops_alert_rules_access ON ops_alert_rules;
--> statement-breakpoint
CREATE POLICY ops_alert_rules_access ON ops_alert_rules FOR ALL
  USING (app_role() IN ('system', 'superadmin'))
  WITH CHECK (app_role() IN ('system', 'superadmin'));
--> statement-breakpoint
ALTER TABLE ops_alert_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ops_alert_events_access ON ops_alert_events;
--> statement-breakpoint
CREATE POLICY ops_alert_events_access ON ops_alert_events FOR ALL
  USING (app_role() IN ('system', 'superadmin'))
  WITH CHECK (app_role() IN ('system', 'superadmin'));
--> statement-breakpoint
ALTER TABLE ops_client_errors ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ops_client_errors_access ON ops_client_errors;
--> statement-breakpoint
CREATE POLICY ops_client_errors_access ON ops_client_errors FOR ALL
  USING (app_role() IN ('system', 'superadmin'))
  WITH CHECK (app_role() IN ('system', 'superadmin'));
--> statement-breakpoint
ALTER TABLE ops_vitals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS ops_vitals_access ON ops_vitals;
--> statement-breakpoint
CREATE POLICY ops_vitals_access ON ops_vitals FOR ALL
  USING (app_role() IN ('system', 'superadmin'))
  WITH CHECK (app_role() IN ('system', 'superadmin'));
