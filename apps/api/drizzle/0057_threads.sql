-- Переписка пациента со своим специалистом.
--
-- Асинхронная и с честными границами: ответ в рабочее время, это не
-- экстренная связь. Обещание круглосуточного ответа в психологическом отделе
-- опаснее отсутствия переписки вовсе — человек в кризис напишет и будет
-- ждать, вместо того чтобы позвонить.

create table if not exists threads (
  id text primary key,
  patient_id text not null references users(id) on delete cascade,
  specialist_id text not null references users(id) on delete cascade,
  created_at timestamp with time zone not null default now(),
  last_message_at timestamp with time zone not null default now(),
  closed_at timestamp with time zone,
  -- Один разговор на пару. Переписка — это не заявки: заводить второй тред с
  -- тем же человеком значит потерять контекст ровно там, где он и нужен.
  unique (patient_id, specialist_id)
);
create index if not exists threads_specialist_idx on threads(specialist_id, last_message_at desc);
create index if not exists threads_patient_idx on threads(patient_id, last_message_at desc);

create table if not exists messages (
  id text primary key,
  thread_id text not null references threads(id) on delete cascade,
  author_id text not null references users(id) on delete cascade,
  -- Шифруется как остальные клинические записи: человек пишет сюда о своём
  -- состоянии, и это такие же сведения о нём, как заметка приёма.
  text_enc text not null,
  sent_at timestamp with time zone not null default now(),
  read_at timestamp with time zone
);
create index if not exists messages_thread_idx on messages(thread_id, sent_at);

alter table threads enable row level security;
drop policy if exists threads_access on threads;
create policy threads_access on threads using (
  app_role() in ('system', 'superadmin')
  or patient_id = app_uid()
  or specialist_id = app_uid()
);

alter table messages enable row level security;
drop policy if exists messages_access on messages;
create policy messages_access on messages using (
  app_role() in ('system', 'superadmin')
  or exists (
    select 1 from threads t
    where t.id = thread_id and (t.patient_id = app_uid() or t.specialist_id = app_uid())
  )
);
