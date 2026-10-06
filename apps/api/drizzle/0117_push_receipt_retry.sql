-- Волна 18, участок delivery: повтор пуша по квитанции Expo (внешний разбор
-- 2026-09-27, #18 и #19) и журнал переиндексаций поиска (#25, в конце файла).
--
-- Билет Expo говорит лишь «принято в очередь»; что устройство не получило,
-- выясняется из квитанции через четверть часа. Прежде квитанция «не
-- передано» (MessageRateExceeded — Expo прямо велит повторить с задержкой)
-- только отмечала исход в push_outcomes: заявка в push_deliveries оставалась
-- с ok = true, повтор отсекался по ключу события, и напоминание не доходило
-- никогда. Связи «билет → заявка» не было: квитанции не по чему было вернуть
-- событие в очередь.
--
-- push_outcomes.delivery_id — заявка, по которой шла отправка. Снятая заявка
-- (сбой сети, отказ билета) оставляет null: исход о ней уже никому не нужен.
-- Это ссылка на доставку, а не на человека: user_id в исходах по-прежнему
-- нет (0091), а по delivery_id техпанель ничего не читает.
--
-- push_deliveries.retry_after — когда заявку можно взять снова; ставится
-- квитанцией вместе с ok = false. До срока pushToUser заявку не берёт, после
-- — берёт ту же строку (исходы продолжают указывать на неё) и шлёт снова.
-- attempts — сколько раз по заявке отправляли: задержка повтора растёт с
-- каждым (15 минут, дальше вдвое, до четырёх часов). Существующие заявки —
-- одна попытка, повтор не назначен.

ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS retry_after timestamptz;
--> statement-breakpoint
ALTER TABLE push_deliveries ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE push_outcomes ADD COLUMN IF NOT EXISTS delivery_id text REFERENCES push_deliveries(id) ON DELETE SET NULL;
--> statement-breakpoint
-- квитанция ищет исходы своей заявки — и каскад SET NULL при снятии заявки идёт по этому же индексу
CREATE INDEX IF NOT EXISTS push_outcomes_delivery_idx ON push_outcomes (delivery_id) WHERE delivery_id IS NOT NULL;
--> statement-breakpoint
-- ═══ Журнал переиндексаций поиска (#25) ═══
--
-- Слепой индекс записей считался на JWT_SECRET: его ротация молча обнуляла
-- поиск по старым записям. Теперь у индекса свой секрет (SEARCH_INDEX_SECRET),
-- а каждая пересборка — строка security_jobs вида search_reindex: на каком
-- секрете строили (target_key — отпечаток секрета, 64 бита HMAC, не сам
-- секрет), сколько записей, сколько пропущено, когда и чем закончили. При
-- старте сервер сравнивает отпечаток текущего секрета с последней завершённой
-- пересборкой и при расхождении пересобирает индекс сам (lib/noteReindex.ts).
-- Имя ограничения — то, что PostgreSQL дал встроенному CHECK в 0092.
ALTER TABLE security_jobs DROP CONSTRAINT IF EXISTS security_jobs_kind_check;
--> statement-breakpoint
ALTER TABLE security_jobs ADD CONSTRAINT security_jobs_kind_check CHECK (kind IN ('reencrypt', 'search_reindex'));
