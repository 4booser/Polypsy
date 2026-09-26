-- Доставка (участок delivery, волна 12): захват расшифровки с арендой и
-- журнал доставки уведомлений о тревогах.
--
-- ═══ visit_recordings: transcribe_claim, transcribe_lease_until ═══
--
-- Расшифровка шла одной транзакцией на всё: захват строки, минуты работы
-- модели, запись итога. Строчный замок держался всё это время — удаление
-- записи и отзыв согласия ждали конца расшифровки, а статус «розшифровується»
-- не был виден до коммита. Теперь захват коммитится сразу, модель работает
-- вне транзакции, итог пишется отдельной короткой транзакцией (см.
-- lib/recordings.ts, transcribeNext).
--
-- Короткий захват лишает строку прежней страховки: упавший посреди работы
-- воркер больше не отпускает её откатом. Поэтому у захвата аренда: воркер
-- продлевает её, пока работает, просроченную берёт следующий. Метка захвата
-- (transcribe_claim) отличает свою аренду от чужой: итог пишется, только
-- если строка всё ещё захвачена этой меткой. Без неё опоздавший воркер
-- записал бы старую стенограмму поверх записи, которую за это время удалили,
-- записали заново и отдали другому воркеру.

ALTER TABLE visit_recordings ADD COLUMN IF NOT EXISTS transcribe_claim text;
--> statement-breakpoint
ALTER TABLE visit_recordings ADD COLUMN IF NOT EXISTS transcribe_lease_until timestamp with time zone;
--> statement-breakpoint

-- ═══ alert_deliveries ═══
--
-- Состояние доставки уведомления о тревоге — по строке на (тревога, вид).
--
-- alert_notifications отвечает «уведомление дошло» и остаётся таким: строка
-- в ней появляется, только когда письмо принял почтовый сервер или пуш ушёл
-- хотя бы одному дежурному. Прежде она писалась и при «none» (почта не
-- настроена, слать некому) — и тревога, о которой не узнал никто, числилась
-- разосланной: после того как почту настроили, первичное уведомление уже не
-- повторялось никогда.
--
-- Здесь — всё, что между «тревога есть» и «дошло»:
--   sending     — рассыльщик взял задание: owner — кто, lease_until — до
--                 какого времени. Два процесса одно письмо не шлют: взять
--                 можно только свободное или просроченное.
--   delivered   — дошло (строка в alert_notifications рядом).
--   undelivered — не дошло ни одним каналом, ничего не ушло; повторяется,
--                 пока тревогу не подтвердили.
--   abandoned   — письмо могло уйти уже mails раз, а подтверждения, что
--                 дошло, так и нет: дальше не шлём, оставляем след.
--
-- mails — сколько раз письмо ушло на почтовый сервер или МОГЛО уйти:
-- счётчик растёт до отправки, а не после, и падает обратно, только если
-- сервер явно отказал. Процесс, упавший между «сервер принял» и «записали»,
-- оставляет его выросшим — поэтому число повторов после таких падений
-- ограничено, а не бесконечно.
--
-- Ссылка на человека — только через тревогу, прямой нет; проверка покрытия
-- политиками (access.test.ts) таблицу не найдёт, но политика ей положена.

CREATE TABLE IF NOT EXISTS alert_deliveries (
  alert_id text NOT NULL REFERENCES risk_alerts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('initial', 'escalation')),
  state text NOT NULL CHECK (state IN ('sending', 'delivered', 'undelivered', 'abandoned')),
  owner text,
  lease_until timestamp with time zone,
  attempts integer NOT NULL DEFAULT 0,
  mails integer NOT NULL DEFAULT 0,
  email text CHECK (email IN ('sent', 'none', 'failed')),
  pushed integer NOT NULL DEFAULT 0,
  error text,
  first_at timestamp with time zone NOT NULL DEFAULT now(),
  last_at timestamp with time zone NOT NULL DEFAULT now(),
  delivered_at timestamp with time zone,
  PRIMARY KEY (alert_id, kind)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS alert_deliveries_open_idx ON alert_deliveries (state)
  WHERE state IN ('sending', 'undelivered');
--> statement-breakpoint
ALTER TABLE alert_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS alert_deliveries_access ON alert_deliveries;
--> statement-breakpoint
CREATE POLICY alert_deliveries_access ON alert_deliveries FOR ALL USING (
  app_role() IN ('system', 'superadmin')
) WITH CHECK (
  app_role() IN ('system', 'superadmin')
);
--> statement-breakpoint

-- ═══ schedules: retry_at, failures ═══
--
-- Сбой прохода по расписанию сдвигал next_run_at на следующий регулярный
-- срок: база моргнула в минуту прохода — и ежемесячный замер не выдавался
-- месяц. Теперь у сбоя свой срок повторной попытки (retry_at) с растущей
-- паузой (failures — сбоев подряд), а плановый срок не трогается: успешная
-- попытка считает следующий от ПЛАНОВОГО, сетка не уползает.

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS retry_at timestamp with time zone;
--> statement-breakpoint
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS failures integer NOT NULL DEFAULT 0;
--> statement-breakpoint

-- ═══ survey_followups ═══
--
-- Окна повторных замеров протокола наблюдения («повторить через 7 и 30
-- дней»). Прежде протокол выдавал один доступ сразу — до последнего повтора
-- плюс две недели, то есть на 44 дня — и сбрасывал счётчик попыток: замер
-- «через неделю» можно было пройти в тот же день, «через месяц» — на
-- десятый, а пропуск недельного всплывал в очереди работы только на 44-й
-- день, когда истекал общий доступ.
--
-- Теперь у каждого повтора своё окно: открывается в свой день и закрывается
-- через две недели или к открытию следующего — что раньше. Окно открывает
-- часовой тик планировщика (lib/followup.ts): выдаёт доступ до закрытия
-- окна, и пропуск видно в очереди работы в день закрытия именно этого окна.
-- Новый замер в той же полосе заменяет ещё не открытые окна новыми —
-- протокол считается от последнего замера.

CREATE TABLE IF NOT EXISTS survey_followups (
  id text PRIMARY KEY,
  survey_id text NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  after_days integer NOT NULL,
  opens_at timestamp with time zone NOT NULL,
  closes_at timestamp with time zone NOT NULL,
  opened_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS survey_followups_due_idx ON survey_followups (opens_at) WHERE opened_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS survey_followups_user_idx ON survey_followups (user_id, survey_id);
--> statement-breakpoint
ALTER TABLE survey_followups ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS survey_followups_access ON survey_followups;
--> statement-breakpoint
-- видимость — как у survey_access (0030): окна — те же выдачи доступа,
-- только будущие; но пишет их только автоматика (каскад идёт под asSystem),
-- поэтому своё пациенту — только на чтение
CREATE POLICY survey_followups_access ON survey_followups FOR ALL USING (
  app_role() IN ('system', 'superadmin')
  OR (app_role() = 'admin' AND rls_admin_sees_survey(survey_id))
);
--> statement-breakpoint
DROP POLICY IF EXISTS survey_followups_own ON survey_followups;
--> statement-breakpoint
CREATE POLICY survey_followups_own ON survey_followups FOR SELECT USING (
  app_role() = 'user' AND user_id = app_uid()
);
