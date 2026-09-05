-- Расписание повторных замеров убрано, и право на него больше не значится в
-- справочнике. Строка в роли, ссылающаяся на несуществующее право, — не
-- безобидный мусор: экран прав показывает её как выданную возможность,
-- которой нет, и разбирающий считает, что человеку что-то доступно.
DELETE FROM role_permissions WHERE permission = 'schedules.manage';
DELETE FROM permission_exceptions WHERE permission = 'schedules.manage';
