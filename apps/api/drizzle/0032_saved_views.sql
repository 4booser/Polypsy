-- Сохранённые виды: именованный срез экрана.
--
-- Хранятся параметры адреса, а не данные. Поэтому общий вид безопасен: он
-- откроет получателю тот же фильтр, но выборку сервер соберёт по ЕГО правам.
create table if not exists saved_views (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  scope text not null,
  name text not null,
  params text not null,
  shared boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists saved_views_owner_scope_idx on saved_views (owner_id, scope);
create unique index if not exists saved_views_unique_name on saved_views (owner_id, scope, name);
