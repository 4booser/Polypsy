-- Поликлиника: отделения, расписание, слоты, приёмы.
--
-- Ни одна существующая таблица не переписывается: у users добавляется одна
-- колонка, всё остальное — новые сущности. Действующее поведение системы не
-- меняется ни на бит до тех пор, пока не появятся маршруты.

create table if not exists departments (
  id text primary key,
  title jsonb not null,
  -- IANA-имя, не смещение: смещение устаревает дважды в год
  timezone text not null default 'Europe/Kyiv',
  created_at timestamp with time zone not null default now(),
  archived_at timestamp with time zone
);

create table if not exists department_patients (
  department_id text not null references departments(id) on delete cascade,
  patient_id text not null references users(id) on delete cascade,
  attached_at timestamp with time zone not null default now(),
  attached_via text not null check (attached_via in ('visit', 'staff')),
  detached_at timestamp with time zone,
  primary key (department_id, patient_id)
);
create index if not exists department_patients_patient_idx on department_patients(patient_id);

create table if not exists specialist_profiles (
  user_id text primary key references users(id) on delete cascade,
  department_id text not null references departments(id) on delete cascade,
  position text,
  room text,
  default_slot_minutes integer not null default 50,
  accepts_bookings boolean not null default true
);
create index if not exists specialist_profiles_department_idx on specialist_profiles(department_id);

create table if not exists schedule_templates (
  id text primary key,
  specialist_id text not null references users(id) on delete cascade,
  -- 1 — понедельник, 7 — воскресенье, как в date_part('isodow')
  weekday integer not null check (weekday between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  slot_minutes integer not null check (slot_minutes > 0),
  kind text not null default 'any' check (kind in ('primary', 'repeat', 'any')),
  capacity integer not null default 1 check (capacity > 0),
  created_at timestamp with time zone not null default now(),
  -- интервал, который кончается раньше, чем начался, — это опечатка, а не расписание
  check (ends_at > starts_at)
);
create index if not exists schedule_templates_specialist_idx on schedule_templates(specialist_id, weekday);

create table if not exists schedule_exceptions (
  id text primary key,
  specialist_id text not null references users(id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('off', 'extra')),
  starts_at time,
  ends_at time,
  slot_minutes integer check (slot_minutes > 0),
  note text,
  created_by text references users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  check (starts_at is null or ends_at is null or ends_at > starts_at),
  -- дополнительный день без часов бессмыслен: непонятно, что добавлять
  check (kind <> 'extra' or (starts_at is not null and ends_at is not null))
);
create index if not exists schedule_exceptions_specialist_idx on schedule_exceptions(specialist_id, date);

create table if not exists slots (
  id text primary key,
  specialist_id text not null references users(id) on delete cascade,
  department_id text not null references departments(id) on delete cascade,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone not null,
  kind text not null default 'any' check (kind in ('primary', 'repeat', 'any')),
  capacity integer not null default 1 check (capacity > 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  off_schedule boolean not null default false,
  created_at timestamp with time zone not null default now(),
  check (ends_at > starts_at)
);
-- идемпотентность генерации держится на этом индексе: дубликат физически невозможен
create unique index if not exists slots_specialist_start_uniq on slots(specialist_id, starts_at);
create index if not exists slots_lookup_idx on slots(department_id, starts_at);

create table if not exists appointments (
  id text primary key,
  slot_id text not null references slots(id) on delete cascade,
  patient_id text not null references users(id) on delete cascade,
  specialist_id text not null references users(id) on delete cascade,
  kind text not null check (kind in ('primary', 'repeat')),
  mode text not null default 'onsite' check (mode in ('onsite', 'remote')),
  meeting_url text,
  status text not null default 'booked' check (
    status in ('booked', 'confirmed', 'arrived', 'in_progress', 'done', 'no_show', 'cancelled')
  ),
  reason_enc text,
  booked_by text references users(id) on delete set null,
  booked_at timestamp with time zone not null default now(),
  confirmed_at timestamp with time zone,
  arrived_at timestamp with time zone,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  cancelled_by text references users(id) on delete set null,
  cancelled_late boolean not null default false
);
create index if not exists appointments_slot_idx on appointments(slot_id);
create index if not exists appointments_patient_idx on appointments(patient_id, booked_at desc);
create index if not exists appointments_specialist_idx on appointments(specialist_id);
-- один человек — один живой приём в слоте; отменённый не мешает записаться снова
create unique index if not exists appointments_slot_patient_live_uniq
  on appointments(slot_id, patient_id) where status <> 'cancelled';

-- Свой специалист. Не путать с прикреплением к отделению: то отвечает
-- «человек обслуживается здесь», это — «у человека есть ведущий».
alter table users add column if not exists lead_specialist_id text references users(id) on delete set null;

-- ── RLS ──
--
-- Расписание и приёмы делятся на два вида данных, и правила у них разные.
--
-- Слот, отделение и профиль специалиста — не персональные данные: это
-- «во вторник в 10:00 у Ивановой свободно». Их читает и пациент, иначе он не
-- сможет выбрать время. Прятать их значило бы прятать вывеску.
--
-- Приём — данные о человеке: сам факт, что он записан к психологу, требует
-- защиты не меньшей, чем результат методики.

alter table departments enable row level security;
drop policy if exists departments_read on departments;
create policy departments_read on departments using (true);

alter table specialist_profiles enable row level security;
drop policy if exists specialist_profiles_read on specialist_profiles;
create policy specialist_profiles_read on specialist_profiles using (true);

alter table slots enable row level security;
drop policy if exists slots_read on slots;
create policy slots_read on slots using (true);

alter table schedule_templates enable row level security;
drop policy if exists schedule_templates_access on schedule_templates;
create policy schedule_templates_access on schedule_templates using (
  app_role() in ('system', 'superadmin', 'admin')
);

alter table schedule_exceptions enable row level security;
drop policy if exists schedule_exceptions_access on schedule_exceptions;
create policy schedule_exceptions_access on schedule_exceptions using (
  app_role() in ('system', 'superadmin', 'admin')
);

-- Прикрепление к отделению: видит сам человек и персонал, которому он виден.
alter table department_patients enable row level security;
drop policy if exists department_patients_access on department_patients;
create policy department_patients_access on department_patients using (
  app_role() in ('system', 'superadmin')
  or patient_id = app_uid()
  or (app_role() = 'admin' and rls_admin_sees_patient(patient_id))
);

-- Приём: свой — пациенту, чужой — специалисту, который его ведёт, и тому,
-- кому виден сам пациент.
alter table appointments enable row level security;
drop policy if exists appointments_access on appointments;
create policy appointments_access on appointments using (
  app_role() in ('system', 'superadmin')
  or patient_id = app_uid()
  or specialist_id = app_uid()
  or (app_role() = 'admin' and rls_admin_sees_patient(patient_id))
);

-- ── видимость пациента расширяется приёмом ──
--
-- Прежнее правило считало пациента «своим», если он соприкасался с
-- методиками группы администратора. Первичный приём ломает это допущение:
-- человек записывается с телефона, ни разу не пройдя ни одной методики, — и
-- специалист, к которому он записан, его бы не увидел. Пациент был бы в
-- расписании и невидим в карте.
--
-- Поэтому добавляются два основания: у меня к нему приём, или он прикреплён
-- к отделению, где я принимаю. Оба — про обслуживание здесь и сейчас, а не
-- про историю измерений.
create or replace function rls_admin_sees_patient(uid text) returns boolean as $$
  select exists (
    select 1 from survey_access sa join surveys s on s.id = sa.survey_id
    where sa.user_id = uid
      and s.group_id in (select ga.group_id from group_admins ga where ga.user_id = app_uid())
  ) or exists (
    select 1 from responses r join surveys s on s.id = r.survey_id
    where r.user_id = uid
      and s.group_id in (select ga.group_id from group_admins ga where ga.user_id = app_uid())
  ) or exists (
    select 1 from battery_assignments ba join batteries b on b.id = ba.battery_id
    where ba.user_id = uid
      and b.group_id in (select ga.group_id from group_admins ga where ga.user_id = app_uid())
  ) or exists (
    select 1 from appointments a
    where a.patient_id = uid and a.specialist_id = app_uid()
  ) or exists (
    select 1 from department_patients dp
    join specialist_profiles sp on sp.department_id = dp.department_id
    where dp.patient_id = uid and dp.detached_at is null and sp.user_id = app_uid()
  )
$$ language sql stable security definer;
