-- Слот с приёмом больше не удаляется каскадом.
--
-- Каскад означал, что удаление слота молча уносит приём: без строки в
-- журнале, без уведомления, при том что пациент видел «вы записаны». Между
-- чтением занятости и удалением слота есть окно, в которое пациент успевает
-- записаться, и защита на уровне кода это окно закрыть не может — она сама
-- в нём и живёт.
--
-- Снимаются оба возможных имени ключа: исходное, данное Postgres, и то, что
-- дал бы drizzle. Иначе на колонке остаются два ключа сразу, каскадный и
-- ограничивающий, и побеждает каскадный — то есть правка выглядит
-- применённой и не делает ничего.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_slot_id_fkey;
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_slot_id_slots_id_fk;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_slot_id_slots_id_fk
  FOREIGN KEY (slot_id) REFERENCES slots(id) ON DELETE RESTRICT;
