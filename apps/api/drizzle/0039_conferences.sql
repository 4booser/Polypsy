-- Консилиум по случаю.
--
-- Сводка для консилиума была, а самого процесса — нет: решение принимали в
-- кабинете и записывали в тетрадь. Через полгода восстановить, кто что
-- предлагал и почему решили именно так, было невозможно.
--
-- Особое мнение — отдельный вид записи, а не примечание: в клинике
-- несогласие участника должно быть видно, а не растворяться в протоколе.

create table if not exists case_conferences (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  reason text not null,
  status text not null default 'open' check (status in ('open','decided','cancelled')),
  decision text,
  decided_at timestamptz,
  decided_by text references users(id) on delete restrict,
  pathway_instance_id text references pathway_instances(id) on delete set null,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists case_conferences_user_idx on case_conferences (user_id);
create index if not exists case_conferences_open_idx on case_conferences (created_at) where status = 'open';

create table if not exists conference_opinions (
  id text primary key,
  conference_id text not null references case_conferences(id) on delete cascade,
  author_id text not null references users(id) on delete restrict,
  text text not null,
  kind text not null default 'opinion' check (kind in ('opinion','dissent')),
  created_at timestamptz not null default now()
);
create index if not exists conference_opinions_conference_idx on conference_opinions (conference_id, created_at);
create unique index if not exists conference_opinions_once on conference_opinions (conference_id, author_id, kind);

alter table case_conferences enable row level security;
alter table conference_opinions enable row level security;

drop policy if exists case_conferences_access on case_conferences;
create policy case_conferences_access on case_conferences
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or rls_admin_sees_patient(user_id)
  );

drop policy if exists conference_opinions_access on conference_opinions;
create policy conference_opinions_access on conference_opinions
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or exists (
      select 1 from case_conferences cc
      where cc.id = conference_opinions.conference_id
        and rls_admin_sees_patient(cc.user_id)
    )
  );
