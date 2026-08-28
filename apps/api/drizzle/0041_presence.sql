-- Присутствие: кто сейчас смотрит на случай или пишет заключение.
--
-- Таблица, а не память процесса: инстансов API может быть несколько, и
-- сотрудник, открывший карту, вполне может попасть на другой. Строка живёт
-- ровно до следующего пульса — читаем только свежие, старые вычищаем на месте.
create table if not exists presence (
  user_id text not null references users(id) on delete cascade,
  resource text not null,
  seen_at timestamptz not null default now(),
  primary key (user_id, resource)
);

create index if not exists presence_resource_idx on presence (resource, seen_at desc);

alter table presence enable row level security;

-- Присутствие видят только сотрудники, и только своё пишут.
drop policy if exists presence_own on presence;
create policy presence_own on presence
  for all
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or current_setting('app.role', true) = 'admin'
  )
  with check (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = current_setting('app.user_id', true)
  );
