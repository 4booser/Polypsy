-- Техпанель, группа «Дані й продукт» (волна 10): открытия экранов, версия
-- приложения и очередь на устройстве, исходы пуш-уведомлений.
--
-- ═══ Что сервер уже знал и чего не знал ═══
--
-- Кто и когда был активен, сервер знает и без новой таблицы: входы лежат в
-- журнале, обновления токенов — в refresh_tokens, прохождения — в responses.
-- Воронка «приглашение → регистрация → первое прохождение → повторное»
-- складывается из invites, invite_uses и responses. Под это миграция не
-- заводит ничего — второе хранилище того же самого разошлось бы с первым.
--
-- Не знал сервер трёх вещей, и под них — три изменения ниже.

/* ── devices: версия сборки и очередь на устройстве ──
   Устройство отмечается при каждом запуске и возвращении сети
   (POST /api/devices/checkin) — и теперь сообщает версию приложения,
   номер сборки и сколько сдач лежит у него в очереди.

   Версия нужна, чтобы знать, сколько людей сидит на старой сборке: исправление
   в движке подсчёта доходит до человека только с новой сборкой, а офлайн он
   считает баллы сам (docs/ARCHITECTURE.md, «Из чего состоит»).

   Очередь — единственный способ увидеть сдачи, которые НЕ пришли. Сервер
   видит досылку, когда она дошла; висящую на телефоне неделю — не видит
   никак. Особенно отклонённые: они не ретраятся сами (offline/queue.ts) и
   ждут, пока человек откроет экран очереди, — а он может не открыть никогда.

   null у всех четырёх — устройство отмечалось до этой миграции; приложение
   пришлёт значения при следующем запуске. */
ALTER TABLE devices ADD COLUMN IF NOT EXISTS app_version text;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS app_build text;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS queue_pending integer;
--> statement-breakpoint
ALTER TABLE devices ADD COLUMN IF NOT EXISTS queue_rejected integer;
--> statement-breakpoint

/* ── screen_views: какие экраны открывают ──
   Счётчик по дню, приложению и ШАБЛОНУ маршрута. Ни человека, ни адреса, ни
   времени до секунды: строка «/patients/:userId открывали 214 раз
   2026-09-26» ничего не говорит ни о ком. Адрес с идентификатором сказал бы,
   чью карточку открывали, — это вопрос журнала чтений, и отвечать на него
   здесь, мимо журнала, нельзя.

   Проверка шаблона стоит на входе (packages/shared/src/usage.ts,
   isRouteTemplate), а здесь — грубая страховка на случай записи в обход
   приложения: ни цифр, ни пробелов, ни точек. Идентификаторы (UUID, числа,
   коды) без цифр почти не бывают.

   День — в поясе учреждения, как у остальных дневных сводок (lib/day.ts). */
CREATE TABLE IF NOT EXISTS screen_views (
  day date NOT NULL,
  app text NOT NULL,
  route text NOT NULL,
  views integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, app, route),
  CONSTRAINT screen_views_app_check CHECK (app IN ('console', 'patient', 'mobile')),
  CONSTRAINT screen_views_route_check CHECK (route ~ '^/[A-Za-z:*/-]*$' AND length(route) <= 120)
);
--> statement-breakpoint

/* ── push_outcomes: что стало с каждым уведомлением ──
   push_deliveries отвечает на вопрос «решили ли отправить человеку это
   событие» и держит идемпотентность; при сбое отправки строка там
   снимается (lib/push.ts), чтобы повтор был возможен, — то есть о сбоях она
   молчит по построению. Здесь — исход по каждому устройству: принял ли
   сервис Expo, что ответил (квитанция: передано ли Apple/Google), и код
   ошибки — DeviceNotRegistered, MessageTooBig, MessageRateExceeded.

   Токен не хранится — только отпечаток (первые 16 знаков SHA-256). Токен —
   адрес устройства человека: с ним можно слать ему уведомления в обход
   системы. Для вопроса «сколько ошибок на скольких устройствах» отпечатка
   достаточно, а читающий техпанель не получает ни одного адреса. По той же
   причине здесь нет user_id: исход уведомления — факт о доставке, а не о
   человеке, и связывать их незачем.

   Срок хранения — полгода (чистит тот же проход, что забирает квитанции):
   дольше вопрос «почему не дошло» не задают. */
CREATE TABLE IF NOT EXISTS push_outcomes (
  id text PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL,
  platform text,
  token_hash text NOT NULL,
  status text NOT NULL,
  error text,
  ticket_id text,
  receipt_status text,
  receipt_error text,
  receipt_at timestamptz,
  CONSTRAINT push_outcomes_status_check CHECK (status IN ('accepted', 'rejected', 'failed')),
  CONSTRAINT push_outcomes_receipt_check CHECK (receipt_status IS NULL OR receipt_status IN ('ok', 'error'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS push_outcomes_at_idx ON push_outcomes (at);
--> statement-breakpoint
-- квитанции забираются по неразобранным билетам — частичный индекс ровно под них
CREATE INDEX IF NOT EXISTS push_outcomes_awaiting_idx ON push_outcomes (at)
  WHERE ticket_id IS NOT NULL AND receipt_status IS NULL;
--> statement-breakpoint

/* ═══════════ Политики строк ═══════════

   Обе таблицы — служебные счётчики: в них нет ни людей, ни клинических
   записей, и читать их по одной строке не нужно никому, кроме системы.
   Пишет система (приём счётчиков и отправка уведомлений идут под asSystem /
   systemContext), читает техпанель — тоже системным контекстом, потому что
   её числа — про всю систему, а не про зону ответственности смотрящего
   (routes/opsData.ts). Суперадмину — как везде.

   Пациенту и персоналу напрямую — ничего: иначе счётчик экранов стал бы
   местом, куда можно писать что угодно в обход проверки шаблона. */
ALTER TABLE screen_views ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS screen_views_access ON screen_views;
--> statement-breakpoint
CREATE POLICY screen_views_access ON screen_views FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
--> statement-breakpoint
ALTER TABLE push_outcomes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS push_outcomes_access ON push_outcomes;
--> statement-breakpoint
CREATE POLICY push_outcomes_access ON push_outcomes FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
