-- Каркас прав: роли-шаблоны и личные исключения.
--
-- Сегодня ролей ровно три (superadmin | admin | user), а область задаётся
-- таблицей group_admins. Выдать конкретному человеку конкретную возможность
-- нельзя: либо он администратор группы целиком, либо никто. Стажёр, который
-- ведёт приёмы, но не должен подписывать заключения, в такую схему не
-- помещается — как и дежурный, которому доступ нужен на смену, а не навсегда.
--
-- Три оси, которые здесь важно не смешать:
--   users.read_only — может ли человек вообще писать (проверяется первой);
--   право          — что он может делать (эти таблицы);
--   область        — над кем (group_admins, не трогаем).
--
-- Роли живут в базе, а не в коде: их набор меняется в учреждении. Сам
-- справочник кодов, наоборот, в коде — новое право требует новой строки
-- проверки в маршруте, и таблица была бы вторым источником истины.

create table if not exists roles (
  id text primary key,
  code text not null unique,
  title jsonb not null,
  -- встроенную роль нельзя удалить: на ней держится бэкфилл, и без неё
  -- действующие учётные записи остались бы без прав вовсе
  is_builtin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists role_permissions (
  role_id text not null references roles(id) on delete cascade,
  -- код права, а не ссылка на справочник: справочник живёт в коде
  permission text not null,
  primary key (role_id, permission)
);

create table if not exists staff_roles (
  user_id text not null references users(id) on delete cascade,
  role_id text not null references roles(id) on delete cascade,
  -- NULL означает «во всей области, которая у человека и так есть» —
  -- то есть по group_admins. Отдельная колонка нужна на будущее: роль
  -- заведующего действует в своём отделении, а не везде
  group_id text references survey_groups(id) on delete cascade,
  granted_by text references users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role_id)
);

create index if not exists staff_roles_role_idx on staff_roles (role_id);

-- Личное исключение: одно право одному человеку, со сроком и причиной.
--
-- Без причины и срока нельзя: бессрочное исключение через год неотличимо от
-- роли, а разбирать надо будет именно исключения. Отнятое побеждает
-- добавленное независимо от порядка строк — так безопаснее при ошибке.
create table if not exists permission_exceptions (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  permission text not null,
  mode text not null check (mode in ('grant', 'revoke')),
  reason text not null,
  granted_by text not null references users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

create index if not exists permission_exceptions_user_idx
  on permission_exceptions (user_id, permission);

alter table roles enable row level security;
alter table role_permissions enable row level security;
alter table staff_roles enable row level security;
alter table permission_exceptions enable row level security;

-- Читать может персонал: экран прав показывает, кто что может, и это не
-- тайна внутри отделения. Писать — через приложение, где проверка своя.
drop policy if exists roles_read on roles;
create policy roles_read on roles using (true);
drop policy if exists role_permissions_read on role_permissions;
create policy role_permissions_read on role_permissions using (true);
drop policy if exists staff_roles_read on staff_roles;
create policy staff_roles_read on staff_roles using (true);
drop policy if exists permission_exceptions_read on permission_exceptions;
create policy permission_exceptions_read on permission_exceptions using (true);

-- ── бэкфилл ──
--
-- Встроенная роль «Психолог» с тем набором, который сегодня имеет
-- администратор группы, и выдача её каждому действующему администратору.
-- Поведение действующих учётных записей не меняется ни на бит: это условие
-- перехода, а не пожелание. Набор прав роли задаётся кодом при старте
-- приложения (PSYCHOLOGIST_PERMISSIONS) — здесь заводится только сама роль
-- и её выдача, чтобы список прав не разъезжался между SQL и справочником.
insert into roles (id, code, title, is_builtin)
values ('role-psychologist', 'psychologist',
        '{"uk":"Психолог","ru":"Психолог"}'::jsonb, true)
on conflict (code) do nothing;

insert into staff_roles (user_id, role_id, group_id)
select u.id, 'role-psychologist', null
from users u
where u.role = 'admin'
on conflict do nothing;
