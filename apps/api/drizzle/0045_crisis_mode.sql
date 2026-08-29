-- Кризисный режим учреждения.
--
-- Одна строка на всё учреждение: режим либо включён, либо нет, и «включён
-- частично» здесь не имеет смысла. Строка добавляется, а не правится:
-- история включений — часть журнала, а не служебная деталь.
create table if not exists crisis_periods (
  id text primary key,
  reason text not null,
  started_by text not null references users(id) on delete restrict,
  started_at timestamptz not null default now(),
  ended_by text references users(id) on delete set null,
  ended_at timestamptz
);

-- Не больше одного открытого периода: два одновременных «кризиса» означали бы,
-- что выключение одного не выключает режим, и никто не поймёт почему.
create unique index if not exists crisis_periods_open_idx
  on crisis_periods ((ended_at is null)) where ended_at is null;

alter table crisis_periods enable row level security;

drop policy if exists crisis_periods_read on crisis_periods;
create policy crisis_periods_read on crisis_periods
  using (true);
