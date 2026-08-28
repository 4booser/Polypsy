-- Личный план безопасности (Стэнли–Браун).
--
-- У методики уже есть safety_plan — текст немедленных действий, одинаковый
-- для всех, кто попал в полосу риска. Это инструкция инструмента. Здесь
-- другое: план конкретного человека, составленный с ним в кабинете, его
-- словами и с его телефонами.

create table if not exists safety_plans (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  version integer not null,
  content text not null,
  active boolean not null default true,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create unique index if not exists safety_plans_user_version_idx on safety_plans (user_id, version);
create index if not exists safety_plans_active_idx on safety_plans (user_id) where active;

-- RLS: план видит сам человек и тот, кто вправе видеть его как пациента.
alter table safety_plans enable row level security;
drop policy if exists safety_plans_access on safety_plans;
create policy safety_plans_access on safety_plans
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or user_id = nullif(current_setting('app.user_id', true), '')
    or rls_admin_sees_patient(user_id)
  );
