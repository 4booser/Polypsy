-- Заметка приёма.
--
-- Заключение привязано к прохождению и отвечает на вопрос «что показала
-- методика». Приём бывает и без методики: беседа, наблюдение, звонок
-- командиру. Такую запись некуда было положить, и она уходила в тетрадь.
--
-- Устройство повторяет заключения намеренно: версии, подпись, шифрование.

create table if not exists patient_notes (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  version integer not null,
  kind text not null default 'session' check (kind in ('intake','session','observation','consult')),
  text text not null,
  status text not null default 'draft' check (status in ('draft','signed')),
  pathway_instance_id text references pathway_instances(id) on delete set null,
  created_by text not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  signed_at timestamptz,
  signed_by text references users(id) on delete restrict
);

create unique index if not exists patient_notes_user_version_idx on patient_notes (user_id, version);
create index if not exists patient_notes_user_idx on patient_notes (user_id, created_at);

-- Подписанное неизменно на уровне БД, как и заключения: договорённости
-- «не править руками» недостаточно, когда речь о клиническом документе.
create or replace function patient_notes_immutable() returns trigger as $$
begin
  if old.status = 'signed' then
    raise exception 'Подписанная заметка неизменяема';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$ language plpgsql;

drop trigger if exists patient_notes_immutable on patient_notes;
create trigger patient_notes_immutable
  before update or delete on patient_notes
  for each row execute function patient_notes_immutable();

-- RLS: заметка — клинические данные о человеке.
alter table patient_notes enable row level security;
drop policy if exists patient_notes_access on patient_notes;
create policy patient_notes_access on patient_notes
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or rls_admin_sees_patient(user_id)
  );
