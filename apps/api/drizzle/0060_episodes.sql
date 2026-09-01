-- Эпизод обслуживания: одно обращение целиком.
--
-- Приёмы, прохождения, заключения и направления лежали рядом, но не были
-- связаны: чтобы понять, «с чем человек приходил в марте и чем это
-- кончилось», приходилось складывать хронологию в голове. Эпизод делает
-- обращение единицей, у которой есть начало, повод, ход и исход.

create table if not exists episodes (
  id text primary key,
  patient_id text not null references users(id) on delete cascade,
  -- Кто ведёт обращение. Не то же, что ведущий специалист человека: человека
  -- ведёт один, а обращений у него может быть несколько, и вести их могут
  -- разные люди.
  lead_specialist_id text references users(id) on delete set null,
  department_id text references departments(id) on delete set null,

  opened_at timestamp with time zone not null default now(),
  closed_at timestamp with time zone,

  -- Повод словами: «после командировки», «направлен командиром». Шифруется
  -- как остальные клинические записи.
  reason_enc text,
  -- Исход при закрытии: тоже словами, и тоже шифруется.
  outcome_enc text,
  outcome_kind text check (outcome_kind is null or outcome_kind in (
    'improved', 'stable', 'worse', 'referred', 'dropped', 'transferred'
  )),

  created_by text references users(id) on delete set null
);

create index if not exists episodes_patient_idx on episodes(patient_id, opened_at desc);
create index if not exists episodes_open_idx on episodes(patient_id) where closed_at is null;

-- Привязки: событие принадлежит эпизоду, а не наоборот. Необязательные —
-- событие вне эпизода это нормально, а не ошибка: человек прошёл
-- общедоступный тест сам по себе, и обращения за этим нет.
alter table appointments add column if not exists episode_id text
  references episodes(id) on delete set null;
alter table conclusions add column if not exists episode_id text
  references episodes(id) on delete set null;
alter table referrals add column if not exists episode_id text
  references episodes(id) on delete set null;
alter table pathway_instances add column if not exists episode_id text
  references episodes(id) on delete set null;

create index if not exists appointments_episode_idx on appointments(episode_id);

alter table episodes enable row level security;
drop policy if exists episodes_access on episodes;
create policy episodes_access on episodes using (
  app_role() in ('system', 'superadmin')
  or patient_id = app_uid()
  or (app_role() = 'admin' and rls_admin_sees_patient(patient_id))
);
