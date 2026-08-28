-- Цель лечения: ядро measurement-based care.
--
-- «Стало полегче» нельзя ни проверить, ни передать коллеге; «ЛАП выше 4 к
-- третьему месяцу» — можно. Достоверность изменения в системе уже считается;
-- цель встраивает её в контур: видно не только «стало лучше», но и
-- «изменение больше ошибки измерения» — а это разные утверждения.

create table if not exists treatment_goals (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  survey_id text not null references surveys(id) on delete cascade,
  scale_code text not null,
  direction text not null check (direction in ('down','up')),
  target_value double precision not null,
  baseline_value double precision,
  due_at timestamptz,
  status text not null default 'open' check (status in ('open','met','missed','cancelled')),
  note text,
  pathway_instance_id text references pathway_instances(id) on delete set null,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists treatment_goals_user_idx on treatment_goals (user_id);
create index if not exists treatment_goals_open_idx on treatment_goals (due_at) where status = 'open';

alter table treatment_goals enable row level security;
drop policy if exists treatment_goals_access on treatment_goals;
create policy treatment_goals_access on treatment_goals
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = nullif(current_setting('app.user_id', true), '')
    or rls_admin_sees_patient(user_id)
  );
