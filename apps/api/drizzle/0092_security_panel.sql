-- Безопасность в техпанели: отметки секретов, фоновые задания перешифровки,
-- результаты проверок целостности.
--
-- ═══ Зачем ═══
--
-- Решение заказчика 2026-09-26: в техпанели — ротация ключей шифрования и
-- секретов с мастером и проверкой, проверка политик строк одной кнопкой и
-- сверка цепочки журнала по расписанию. Всему этому нужна память между
-- запусками процесса, и хранить её, кроме базы, негде: процессов API может
-- быть несколько, а после перезапуска память процесса пуста.
--
-- ═══ security_secret_marks — когда секрет меняли ═══
--
-- Узнать возраст секрета из окружения нельзя: переменная не несёт даты.
-- Поэтому система сама отмечает, КОГДА увидела новое значение, — сравнивая
-- отпечаток текущего значения с запомненным. Отпечаток — первые 8
-- шестнадцатеричных знаков HMAC-SHA256 с самим секретом в роли ключа.
--
-- Почему это не утечка. Восстановить секрет из 32 бит нельзя; проверить
-- догадку можно — но для сильного секрета перебор бессмыслен, а для слабого
-- оракул и так лежит в базе и в сети: подпись любого токена (JWT_SECRET),
-- слепой индекс телефона (PHONE_INDEX_SECRET), коды субъекта в выгрузках
-- (EXPORT_SECRET). Усечение до 32 бит нарочно: для обнаружения смены их
-- хватает с вероятностью ошибки 2^-32, а как проверка догадки они дают
-- миллиарды ложных совпадений на большом переборе. Наружу (в ответы API)
-- отпечаток не уходит никогда — экран получает только «задан / не задан» и
-- даты.
--
-- seen_since — с какого момента видно текущее значение; tracked_since — с
-- какого момента за этим секретом вообще следят. Совпадают — значит смены
-- при нас не было, и возраст честно показывается как «не меньше, чем».
--
-- ═══ security_jobs — перешифровка и её ход ═══
--
-- Перешифровка идёт порциями в фоне и видна экрану по ходу. Ход — в базе, а
-- не в памяти: опрос экрана может прийти в другой процесс, а оборванный
-- перезапуском проход должен остаться видимым как оборванный, а не исчезнуть.
-- Сам проход возобновляем без этой таблицы: уже перешифрованные значения
-- лежат на основном ключе и повторно не выбираются.
--
-- ═══ integrity_checks — результаты проверок ═══
--
-- Сверка цепочки журнала раз в сутки идёт в планировщике, и её результат
-- должен быть виден в разделе «Цілісність» — в том числе проваленный.
-- Провал дополнительно пишется в журнал (sec.audit_chain_broken) и в лог
-- процесса (log.error), но журнал — не место, откуда экран читает «как
-- прошла последняя проверка»: для этого у него есть своя таблица.
--
-- ═══ Политики строк ═══
--
-- Все три таблицы — служебные, о людях в них нет ничего, кроме ссылки на
-- того, кто запустил проверку или перешифровку. Читают и пишут их
-- суперадмин (маршруты раздела закрыты ролью) и система (планировщик,
-- фоновый проход). Администратору и пациенту в них делать нечего.

CREATE TABLE IF NOT EXISTS security_secret_marks (
  name text PRIMARY KEY,
  fingerprint text,
  seen_since timestamptz NOT NULL DEFAULT now(),
  tracked_since timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS security_jobs (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('reencrypt')),
  status text NOT NULL CHECK (status IN ('running', 'done', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  started_by text REFERENCES users(id) ON DELETE SET NULL,
  target_key text,
  total integer NOT NULL DEFAULT 0,
  processed integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  error text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS security_jobs_kind_started_idx ON security_jobs (kind, started_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS integrity_checks (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('audit_chain', 'rls')),
  trigger text NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  at timestamptz NOT NULL DEFAULT now(),
  ok boolean NOT NULL,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  summary jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS integrity_checks_kind_at_idx ON integrity_checks (kind, trigger, at DESC);
--> statement-breakpoint

ALTER TABLE security_secret_marks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS security_secret_marks_access ON security_secret_marks;
--> statement-breakpoint
CREATE POLICY security_secret_marks_access ON security_secret_marks FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
--> statement-breakpoint

ALTER TABLE security_jobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS security_jobs_access ON security_jobs;
--> statement-breakpoint
CREATE POLICY security_jobs_access ON security_jobs FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
--> statement-breakpoint

/* ═══ Подписанные заметки приёма и перешифровка ═══

   Триггер неизменяемости заметок (0034) не знал служебного режима, в
   отличие от триггера заключений (0015): подписанную заметку нельзя было
   тронуть вообще — и перешифровать тоже. Ротация ключа упиралась в первую
   же подписанную заметку («Подписанная заметка неизменяема»), и старый ключ
   нельзя было убрать никогда: на нём навсегда оставались ровно самые
   ценные записи.

   Обход — уже, чем у заключений. В служебном режиме (app.maintenance = 1,
   его ставит только проход перешифровки/бэкфилла, SET LOCAL в своей
   транзакции) разрешается UPDATE, который меняет ОДНУ колонку — text, то
   есть шифртекст. Статус, автора, время подписи, версию служебный режим не
   трогает: строка вне text сравнивается целиком, и любое расхождение —
   прежний отказ. Удаление подписанной заметки запрещено по-прежнему. */
CREATE OR REPLACE FUNCTION patient_notes_immutable() RETURNS trigger AS $$
BEGIN
  IF old.status = 'signed' THEN
    IF tg_op = 'UPDATE'
       AND current_setting('app.maintenance', true) = '1'
       AND (to_jsonb(new) - 'text') = (to_jsonb(old) - 'text') THEN
      RETURN new;
    END IF;
    RAISE EXCEPTION 'Подписанная заметка неизменяема';
  END IF;
  RETURN CASE WHEN tg_op = 'DELETE' THEN old ELSE new END;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

ALTER TABLE integrity_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS integrity_checks_access ON integrity_checks;
--> statement-breakpoint
CREATE POLICY integrity_checks_access ON integrity_checks FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
