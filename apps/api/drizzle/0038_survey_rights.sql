-- Правовой статус и сверка ключей — свойства данных, а не строчка в README.
--
-- README честно фиксировал, что тексты требуют очистки прав перед
-- клиническим применением, но README не мешает выдать методику пациенту.
-- Здесь статус виден в интерфейсе, а демонстрационные методики перестают
-- попадать в клинические списки: «(демо)» в названии было единственной
-- защитой.

alter table surveys add column if not exists rights_status text not null default 'unclear'
  check (rights_status in ('own','licensed','public_domain','unclear'));
alter table surveys add column if not exists source_note text;
alter table surveys add column if not exists is_demo boolean not null default false;
alter table surveys add column if not exists keys_verified_at timestamptz;
alter table surveys add column if not exists keys_verified_by text references users(id) on delete set null;

-- Уже посеянные демонстрационные методики помечаются по названию: это
-- разовая правка данных, дальше флаг ставится руками при заведении.
update surveys
set is_demo = true
where title::text ilike '%демо%' or title::text ilike '%demo%';
