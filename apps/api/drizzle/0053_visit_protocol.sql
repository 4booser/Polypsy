-- Заметка приёма становится протоколом приёма.
--
-- Привязка необязательна: запись о человеке бывает и вне приёма — наблюдение,
-- разбор случая, консультация коллеги. Обязательной её делать нельзя, иначе
-- половина клинических записей потеряет место, где жила.
alter table patient_notes add column if not exists appointment_id text
  references appointments(id) on delete set null;

create index if not exists patient_notes_appointment_idx on patient_notes(appointment_id);
