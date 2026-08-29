-- «Разбить стекло»: доступ вне своей группы в неотложной ситуации.
--
-- Сейчас доступ либо есть, либо нет. В кризисе это плохо: человек поступает
-- ночью, его карта в чужой группе, а дежурный либо ждёт до утра, либо кто-то
-- раздаёт права насовсем — и они остаются навсегда.
--
-- Доступ выдаётся самим сотрудником, но с обоснованием, на срок и громко:
-- запись в журнале, уведомление суперадмину и владельцам группы. Тихого
-- варианта нет намеренно — тихий обход правил это не обход, а дыра.
create table if not exists break_glass (
  id text primary key,
  actor_id text not null references users(id) on delete cascade,
  patient_id text not null references users(id) on delete cascade,
  reason text not null,
  granted_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by text references users(id) on delete set null
);

create index if not exists break_glass_actor_idx on break_glass (actor_id, expires_at desc);
create index if not exists break_glass_patient_idx on break_glass (patient_id, granted_at desc);

alter table break_glass enable row level security;

-- Видно всем сотрудникам: смысл в громкости, а не в приватности самой записи.
drop policy if exists break_glass_access on break_glass;
create policy break_glass_access on break_glass using (true);
