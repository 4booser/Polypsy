-- Учёт устройств и удалённое стирание.
--
-- Планшет носят по отделению, и потерять его проще, чем ноутбук. На нём лежит
-- кэш обхода: имена, баллы, планы безопасности.
--
-- Важное ограничение, записанное здесь, а не только в документации: стирание
-- происходит, когда устройство В СЛЕДУЮЩИЙ РАЗ выйдет на связь. Устройство,
-- которое больше не включат, этой командой не очистить — от этого защищает
-- шифрование хранилища и блокировка экрана, а не она.
create table if not exists devices (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  label text,
  platform text,
  last_seen_at timestamptz not null default now(),
  wipe_requested_at timestamptz,
  wipe_requested_by text references users(id) on delete set null,
  wiped_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists devices_user_idx on devices (user_id, last_seen_at desc);

alter table devices enable row level security;

drop policy if exists devices_access on devices;
create policy devices_access on devices
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = nullif(current_setting('app.user_id', true), '')
  );
