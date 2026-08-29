-- Слепой индекс для поиска по зашифрованным записям.
--
-- В базе лежат не слова, а отпечатки основ: HMAC на секрете приложения.
-- Обычный tsvector по шифртексту — это индекс по случайным байтам, а
-- расшифровывать всё при каждом поиске значит отменить шифрование.
create table if not exists note_search (
  note_id text not null,
  kind text not null,
  user_id text not null references users(id) on delete cascade,
  fp text not null,
  primary key (note_id, fp)
);

create index if not exists note_search_fp_idx on note_search (fp);
create index if not exists note_search_user_idx on note_search (user_id);

alter table note_search enable row level security;

drop policy if exists note_search_access on note_search;
create policy note_search_access on note_search
  using (
    current_setting('app.role', true) in ('system', 'superadmin')
    or rls_admin_sees_patient(user_id)
  );
