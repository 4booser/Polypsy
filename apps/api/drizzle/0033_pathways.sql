-- Маршруты помощи: путь от скрининга до исхода.
--
-- Скрининг, углублённое обследование, решение, вмешательство и повторный
-- замер в системе уже есть по отдельности и связываются в голове
-- специалиста. Маршрут делает связь явной — и тогда видно главное: кто
-- застрял и на каком шаге.

create table if not exists pathways (
  id text primary key,
  title jsonb not null,
  description jsonb,
  group_id text references survey_groups(id) on delete set null,
  active boolean not null default true,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists pathways_group_idx on pathways (group_id);

create table if not exists pathway_steps (
  id text primary key,
  pathway_id text not null references pathways(id) on delete cascade,
  position integer not null,
  title jsonb not null,
  kind text not null check (kind in ('survey','battery','referral','action','decision')),
  survey_id text references surveys(id) on delete set null,
  battery_id text references batteries(id) on delete set null,
  due_days integer,
  required boolean not null default true
);
create index if not exists pathway_steps_pathway_idx on pathway_steps (pathway_id, position);

create table if not exists pathway_instances (
  id text primary key,
  pathway_id text not null references pathways(id) on delete restrict,
  user_id text not null references users(id) on delete cascade,
  started_at timestamptz not null default now(),
  started_by text not null references users(id) on delete restrict,
  closed_at timestamptz,
  closed_by text references users(id) on delete restrict,
  outcome text check (outcome in ('resolved','referred','ongoing','dropped')),
  note text
);
create index if not exists pathway_instances_user_idx on pathway_instances (user_id);
create index if not exists pathway_instances_open_idx on pathway_instances (started_at) where closed_at is null;

create table if not exists pathway_progress (
  id text primary key,
  instance_id text not null references pathway_instances(id) on delete cascade,
  step_id text not null references pathway_steps(id) on delete cascade,
  due_at timestamptz,
  state text not null default 'pending' check (state in ('pending','done','skipped')),
  done_at timestamptz,
  done_by text references users(id) on delete restrict,
  response_id text references responses(id) on delete set null,
  referral_id text references referrals(id) on delete set null,
  note text
);
create index if not exists pathway_progress_instance_idx on pathway_progress (instance_id);
create index if not exists pathway_progress_due_idx on pathway_progress (due_at) where state = 'pending';
create unique index if not exists pathway_progress_unique on pathway_progress (instance_id, step_id);

-- RLS: маршрут привязан к человеку, значит это клинические данные.
-- Политика зеркалит доступ к пациенту: сотрудник видит маршруты тех, кого
-- он и так вправе видеть; пациент — только свои.
alter table pathway_instances enable row level security;
alter table pathway_progress enable row level security;

drop policy if exists pathway_instances_access on pathway_instances;
create policy pathway_instances_access on pathway_instances
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = nullif(current_setting('app.user_id', true), '')
    or rls_admin_sees_patient(user_id)
  );

drop policy if exists pathway_progress_access on pathway_progress;
create policy pathway_progress_access on pathway_progress
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or exists (
      select 1 from pathway_instances i
      where i.id = pathway_progress.instance_id
        and (
          i.user_id = nullif(current_setting('app.user_id', true), '')
          or rls_admin_sees_patient(i.user_id)
        )
    )
  );
