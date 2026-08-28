-- Поддержка решений: правила, их срабатывания и дежурная смена.
--
-- Система предлагает, человек решает. Поэтому срабатывание — это строка со
-- статусом «предложено», а не выполненное действие: принятие и отклонение
-- фиксируются отдельно, вместе с тем, кто и когда это сделал.

create table if not exists decision_rules (
  id text primary key,
  title text not null,
  group_id text references survey_groups(id) on delete set null,
  enabled boolean not null default true,
  -- условия и действия хранятся как JSON: набор видов будет расти, и каждая
  -- новая колонка на каждый вид означала бы миграцию на каждое правило
  conditions jsonb not null,
  actions jsonb not null,
  version integer not null default 1,
  note text,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists decision_rules_group_idx on decision_rules (group_id, enabled);

create table if not exists rule_hits (
  id text primary key,
  rule_id text not null references decision_rules(id) on delete cascade,
  -- версия правила на момент срабатывания: правило потом поправят, а объяснение
  -- должно остаться верным для того случая, который уже разобрали
  rule_version integer not null,
  response_id text not null references responses(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  survey_id text not null references surveys(id) on delete cascade,
  -- почему сработало: значения, которые проверялись, в человеческом виде
  explanation jsonb not null,
  status text not null default 'suggested',
  decided_by text references users(id) on delete set null,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);

create index if not exists rule_hits_status_idx on rule_hits (status, created_at desc);
create index if not exists rule_hits_user_idx on rule_hits (user_id, created_at desc);

create table if not exists duty_shifts (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  group_id text references survey_groups(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists duty_shifts_window_idx on duty_shifts (starts_at, ends_at);

alter table decision_rules enable row level security;
alter table rule_hits enable row level security;
alter table duty_shifts enable row level security;

drop policy if exists decision_rules_access on decision_rules;
create policy decision_rules_access on decision_rules
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or group_id is null
    or group_id in (
      select ga.group_id from group_admins ga
      where ga.user_id = nullif(current_setting('app.user_id', true), '')
    )
  );

drop policy if exists rule_hits_access on rule_hits;
create policy rule_hits_access on rule_hits
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or rls_admin_sees_survey(survey_id)
  );

drop policy if exists duty_shifts_access on duty_shifts;
create policy duty_shifts_access on duty_shifts
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = current_setting('app.user_id', true)
    or current_setting('app.role', true) = 'admin'
  );
