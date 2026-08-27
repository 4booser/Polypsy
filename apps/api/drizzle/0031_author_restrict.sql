-- Авторство клинических документов нельзя обнулить.
--
-- Три ключа были объявлены ON DELETE SET NULL на колонках NOT NULL: удаление
-- пользователя не «обнуляло автора», а падало с нарушением NOT NULL — то есть
-- поведение при удалении вообще не было определено осмысленно.
--
-- Правильная семантика — RESTRICT, как у остальных created_by: заключение,
-- текст согласия и направление это документы, у которых есть составитель, и
-- он должен оставаться названным. Учётную запись выводят из работы через
-- read_only, а не удалением.
--
-- Отдельно signed_by: колонка допускает NULL, поэтому SET NULL отработал бы
-- молча и стёр, КТО подписал заключение — подпись без подписавшего.

alter table conclusions drop constraint if exists conclusions_created_by_users_id_fk;
alter table conclusions add constraint conclusions_created_by_users_id_fk
  foreign key (created_by) references users(id) on delete restrict;

alter table conclusions drop constraint if exists conclusions_signed_by_users_id_fk;
alter table conclusions add constraint conclusions_signed_by_users_id_fk
  foreign key (signed_by) references users(id) on delete restrict;

alter table consent_texts drop constraint if exists consent_texts_created_by_users_id_fk;
alter table consent_texts add constraint consent_texts_created_by_users_id_fk
  foreign key (created_by) references users(id) on delete restrict;

alter table referrals drop constraint if exists referrals_created_by_users_id_fk;
alter table referrals add constraint referrals_created_by_users_id_fk
  foreign key (created_by) references users(id) on delete restrict;
