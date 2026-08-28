-- Пуш-уведомления: токены устройств и журнал отправок.
--
-- Приложение молчало: назначили обследование — человек узнавал, когда сам
-- заходил. Для повторных замеров по расписанию это означало, что половина
-- просто не приходит.
--
-- Журнал отправок играет ту же роль, что alert_notifications для почты:
-- идемпотентность и доказательство. Уведомление, ушедшее дважды, приучает
-- игнорировать уведомления — это дороже, чем не отправить вовсе.

create table if not exists push_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  token text not null,
  platform text not null check (platform in ('ios','android','web')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create unique index if not exists push_tokens_token_idx on push_tokens (token);
create index if not exists push_tokens_user_idx on push_tokens (user_id);

create table if not exists push_deliveries (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  event_key text not null,
  kind text not null,
  sent_at timestamptz not null default now(),
  ok boolean not null default true,
  error text
);
create unique index if not exists push_deliveries_unique on push_deliveries (user_id, event_key);
create index if not exists push_deliveries_sent_idx on push_deliveries (sent_at);
