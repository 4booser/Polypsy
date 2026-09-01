-- Шаблоны заключений и заметок, справочник формулировок.
--
-- Отделение пишет одни и те же обороты десятками раз: «жалоб на момент
-- осмотра не предъявляет», «динамика положительная, рекомендован повторный
-- замер через месяц». Каждый раз набирать их заново — это не только время,
-- но и разнобой: одно и то же состояние в двух заключениях описано разными
-- словами, и сравнить их потом нельзя.

create table if not exists text_templates (
  id text primary key,
  -- Отделение, чья это библиотека. NULL — общая для учреждения: часть
  -- формулировок одинакова везде, и заводить их в каждом отделении заново
  -- значит получить пять расходящихся копий.
  department_id text references departments(id) on delete cascade,
  -- Шаблон подставляется целиком, формулировка — в место курсора.
  -- Это разное поведение, а не разное оформление, поэтому вид хранится.
  kind text not null check (kind in ('conclusion', 'note', 'phrase')),
  title text not null,
  body text not null,
  created_by text references users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  archived_at timestamp with time zone
);

create index if not exists text_templates_lookup_idx
  on text_templates(kind, department_id) where archived_at is null;

-- Читают все сотрудники: библиотека формулировок — не тайна внутри отделения.
alter table text_templates enable row level security;
drop policy if exists text_templates_read on text_templates;
create policy text_templates_read on text_templates using (
  app_role() in ('system', 'superadmin', 'admin')
);
