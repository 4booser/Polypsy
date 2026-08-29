-- Мульти-информант: оценка не только самоотчётом.
--
-- В военной психодиагностике расхождение между самоотчётом и наблюдением
-- командира — самостоятельный сигнал, а не помеха. Поэтому форма информанта
-- это отдельная методика (administration = 'informant'), а не второй способ
-- заполнить ту же: смешивать их в одной выборке значило бы испортить и нормы,
-- и альфу.

alter table surveys drop constraint if exists surveys_administration_check;

create table if not exists informant_requests (
  id text primary key,
  -- о ком спрашивают
  patient_id text not null references users(id) on delete cascade,
  survey_id text not null references surveys(id) on delete cascade,
  -- кто отвечает: роль, а не личность. Имя информанта не хранится намеренно —
  -- оценка командира не должна превращаться в личное дело того, кто её дал
  role text not null,
  token_hash text not null,
  note text,
  created_by text not null references users(id) on delete restrict,
  expires_at timestamptz not null,
  -- заполненное прохождение; null пока не отвечено
  response_id text references responses(id) on delete set null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists informant_requests_hash_idx on informant_requests (token_hash);
create index if not exists informant_requests_patient_idx on informant_requests (patient_id, created_at desc);

alter table informant_requests enable row level security;

drop policy if exists informant_requests_access on informant_requests;
create policy informant_requests_access on informant_requests
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or rls_admin_sees_patient(patient_id)
  );
