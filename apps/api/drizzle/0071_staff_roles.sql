-- Четыре уровня персонала вместо одного.
--
-- Было: технический суперадмин и «психолог» — одна роль на всех, кто ведёт
-- людей. Заведующий отделением при этом не отличался от специалиста ничем,
-- а главного врача не было вовсе: смотреть на учреждение целиком мог только
-- тот, у кого есть доступ к учётным записям и журналу, — то есть человек,
-- которому по должности этого не нужно.
--
-- Роли заводятся ПРАВИМЫМИ (is_builtin = false), и это решение, а не
-- недосмотр. Встроенная роль правится только кодом: её состав прав
-- пересчитывается при старте приложения, и то, что не совпало, молча
-- возвращается на место. Здесь же состав — предположение о том, как устроено
-- конкретное учреждение, и поправить его должен заведующий, а не выкат.
--
-- Права взяты из справочника packages/shared/src/permissions.ts. Если
-- название права там изменится, эти строки просто не найдут его — и роль
-- останется без него, что видно на экране прав.
insert into roles (id, code, title, is_builtin) values
  ('role-chief', 'chief', '{"uk":"Головний лікар","ru":"Главный врач"}'::jsonb, false),
  ('role-head', 'head', '{"uk":"Завідувач відділення","ru":"Заведующий отделением"}'::jsonb, false),
  ('role-specialist', 'specialist', '{"uk":"Спеціаліст","ru":"Специалист"}'::jsonb, false)
on conflict (code) do nothing;

-- Специалист: ведёт людей. Ни аналитики по учреждению, ни выгрузок, ни
-- редактора методик — ключи подсчёта портят ВСЕ будущие измерения, и правит
-- их тот, кто за них отвечает.
insert into role_permissions (role_id, permission)
select 'role-specialist', p from unnest(array[
  'patients.read','notes.write','conclusions.write','referrals.manage','episodes.manage',
  'safety.manage','schedule.own','appointments.manage','messages.write',
  'alerts.review','surveys.read','assignments.manage','administer'
]) p
on conflict do nothing;

-- Заведующий отделением: то же плюс отделение целиком — расписание чужих
-- приёмов, разбор случаев, аналитика и подпись заключений за отделение.
insert into role_permissions (role_id, permission)
select 'role-head', p from unnest(array[
  'patients.read','notes.write','conclusions.write','conclusions.sign','referrals.manage',
  'episodes.manage','safety.manage','schedule.own','appointments.manage','departments.manage',
  'messages.write','alerts.review','surveys.read','surveys.publish','batteries.manage',
  'assignments.manage','administer','norms.manage',
  'analytics.read','cohorts.read','export.deidentified'
]) p
on conflict do nothing;

-- Главный врач: учреждение целиком. Учётные записи, права и журнал доступа
-- сюда НЕ входят: это работа технического администратора, и смешивать их
-- значило бы, что человек, отвечающий за медицину, может незаметно раздать
-- себе всё остальное.
insert into role_permissions (role_id, permission)
select 'role-chief', p from unnest(array[
  'patients.read','notes.write','conclusions.write','conclusions.sign','referrals.manage',
  'episodes.manage','safety.manage','schedule.own','appointments.manage','departments.manage',
  'messages.write','alerts.review','surveys.read','surveys.publish','surveys.edit',
  'batteries.manage','assignments.manage','administer','norms.manage',
  'analytics.read','cohorts.read','export.deidentified','export.full'
]) p
on conflict do nothing;
