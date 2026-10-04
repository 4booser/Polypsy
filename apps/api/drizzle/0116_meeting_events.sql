-- Событие Google Calendar у дистанционного приёма (волна 18, участок clinic;
-- внешний разбор, #37).
--
-- При создании ссылки на встречу сохранялась только сама ссылка
-- (hangoutLink), без идентификатора события и без того, в чьём календаре оно
-- лежит. Перенос менял слот и специалиста, отмена — статус, а внешнее
-- событие оставалось прежним: у врача в календаре стояла встреча на снятое
-- время, у нового врача её не было вовсе, отменённый приём висел в
-- календаре как живой.
--
-- Теперь приём помнит событие (meeting_event_id) и его организатора
-- (meeting_organizer_id — специалист, в чьём календаре оно создано), а
-- перенос и отмена сводят календарь с приёмом (lib/meetSync.ts): тот же
-- специалист — событие переносится; другой — старое событие удаляется у
-- прежнего, новое создаётся у нового; отмена — удаляется.
--
-- Сбой внешнего сервиса не теряет операцию: meeting_sync_at — когда надо
-- попробовать снова (null — календарь сведён), meeting_sync_attempts — сколько
-- попыток было. Фоновый проход (startNotifier) берёт просроченные строки и
-- доводит их до конца; повтор не создаёт дубликатов — новое событие
-- создаётся только после того, как прежнего в строке уже нет.
--
-- Политик строк не добавляется: это поля приёма, и видны они тем же, кому
-- виден приём (0051). Существующие ссылки без идентификатора события
-- остаются как есть — сводить их не с чем, специалист правит такую встречу
-- в календаре сам.

ALTER TABLE appointments ADD COLUMN IF NOT EXISTS meeting_event_id text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS meeting_organizer_id text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS meeting_sync_at timestamp with time zone;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS meeting_sync_attempts integer NOT NULL DEFAULT 0;

-- фоновый проход читает только то, что ждёт сведения
CREATE INDEX IF NOT EXISTS appointments_meeting_sync_idx ON appointments (meeting_sync_at)
  WHERE meeting_sync_at IS NOT NULL;
