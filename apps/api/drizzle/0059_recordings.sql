-- Запись приёма голосом.
--
-- Самые чувствительные данные в системе: не «результат методики», а разговор
-- человека о себе целиком. Отсюда всё остальное в этой таблице.

create table if not exists visit_recordings (
  id text primary key,
  appointment_id text not null references appointments(id) on delete cascade,
  patient_id text not null references users(id) on delete cascade,
  specialist_id text not null references users(id) on delete cascade,

  -- Согласие на запись ИМЕННО ЭТОГО приёма.
  --
  -- Не галочка в общем согласии, подписанном год назад: согласие на запись
  -- разговора даётся в тот разговор, который записывают. Без отметки запись
  -- не начинается, и это проверяет сервер, а не кнопка.
  consent_at timestamp with time zone,
  -- Кто отметил согласие. Пациент со своего устройства — сам; на приёме без
  -- телефона отмечает специалист, и тогда видно, что согласие получено
  -- голосом, а не нажатием пациента.
  consent_by text references users(id) on delete set null,

  started_at timestamp with time zone,
  ended_at timestamp with time zone,
  duration_ms integer,

  -- Путь к зашифрованному файлу. Само аудио в базе не лежит: часовой приём
  -- это десятки мегабайт, и класть их в строку значит превратить бэкап базы
  -- в неподъёмный.
  audio_path text,
  audio_bytes integer,

  -- Расшифровка. Шифруется как остальные клинические записи.
  transcript_enc text,
  -- Чем расшифровано: модель и версия. Без этого через год не понять,
  -- почему одна стенограмма лучше другой.
  transcript_engine text,
  transcript_at timestamp with time zone,

  status text not null default 'consent_pending' check (status in (
    'consent_pending',  -- согласия ещё нет, запись невозможна
    'ready',            -- согласие есть, можно начинать
    'recording',        -- идёт запись
    'uploaded',         -- аудио получено, ждёт расшифровки
    'transcribing',
    'done',
    'failed',
    'discarded'         -- удалено до расшифровки по требованию любой стороны
  )),
  failure text,

  created_at timestamp with time zone not null default now(),
  -- Удаление: файл стирается, строка остаётся. Иначе не видно, что запись
  -- была и её убрали — а это ровно то, что нужно знать при разборе.
  discarded_at timestamp with time zone,
  discarded_by text references users(id) on delete set null,

  -- Одна запись на приём. Две дорожки одного разговора — это две версии
  -- того, что было сказано, и выбирать между ними некому.
  unique (appointment_id)
);

create index if not exists visit_recordings_status_idx on visit_recordings(status)
  where status in ('uploaded', 'transcribing');

alter table visit_recordings enable row level security;
drop policy if exists visit_recordings_access on visit_recordings;
create policy visit_recordings_access on visit_recordings using (
  app_role() in ('system', 'superadmin')
  or patient_id = app_uid()
  or specialist_id = app_uid()
);
