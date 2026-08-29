-- Сохранённые когорты.
--
-- Когорта — это не список людей, а правило отбора. Хранить список означало бы
-- заморозить его на день сохранения: «мужчины 20–30 с низким ЛАП» через месяц
-- это другие люди, и наблюдать во времени надо именно правило.
create table if not exists cohorts (
  id text primary key,
  title text not null,
  spec jsonb not null,
  note text,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cohorts_author_idx on cohorts (created_by, created_at desc);

alter table cohorts enable row level security;

drop policy if exists cohorts_access on cohorts;
create policy cohorts_access on cohorts
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or created_by = nullif(current_setting('app.user_id', true), '')
  );
