-- Диспансерное наблюдение.
--
-- Человек на учёте должен показываться раз в столько-то месяцев. Сейчас это
-- держат в голове и в бумажном журнале, а значит теряют: просрочка не видна
-- никому, пока кто-нибудь случайно не вспомнит.

create table if not exists dispensary (
  patient_id text primary key references users(id) on delete cascade,
  -- Группа учёта: словами учреждения, а не кодом. Разряды у отделений разные,
  -- и справочник в коде устарел бы в первом же учреждении.
  group_label text not null,
  -- Раз в сколько месяцев показываться. Без умолчания в коде: срок задаёт
  -- специалист, а «раз в квартал по умолчанию» превратился бы в правило,
  -- которого никто не принимал.
  interval_months integer not null check (interval_months between 1 and 36),
  -- Последний состоявшийся осмотр по учёту и следующий по сроку.
  last_seen_at timestamp with time zone,
  next_due_at timestamp with time zone not null,
  note text,
  added_by text references users(id) on delete set null,
  added_at timestamp with time zone not null default now(),
  removed_at timestamp with time zone,
  removed_by text references users(id) on delete set null
);

create index if not exists dispensary_due_idx on dispensary(next_due_at)
  where removed_at is null;

alter table dispensary enable row level security;
drop policy if exists dispensary_access on dispensary;
create policy dispensary_access on dispensary using (
  app_role() in ('system', 'superadmin')
  or patient_id = app_uid()
  or (app_role() = 'admin' and rls_admin_sees_patient(patient_id))
);
