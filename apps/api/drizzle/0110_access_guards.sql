-- Права и связи, которые держит база, а не только маршрут (волна 15,
-- участок access; внешний разбор 2026-09-27, пп. 1 и 5).
--
-- 1. Заметка приёма — только с приёмом того же человека.
--
-- patient_notes.appointment_id был голым текстом без ключа: маршрут принимал
-- любой идентификатор, и заметка пациента A ложилась протоколом приёма
-- пациента B (карточка приёма ищет протокол по одному appointment_id). Маршрут
-- теперь сверяет принадлежность сам (routes/notes.ts) — здесь то же правило
-- для любого входа: составной внешний ключ (appointment_id, user_id) →
-- appointments (id, patient_id). Пустой appointment_id ключ не проверяет
-- (MATCH SIMPLE): заметка без приёма законна, как и была.
--
-- Цель ключа — уникальная пара (id, patient_id). id и так первичный ключ, и
-- пара уникальна по построению; индекс нужен ключу как опора.
--
-- ON DELETE — по умолчанию (NO ACTION), не SET NULL. Удаление пациента
-- уносит каскадом и приёмы, и заметки одним оператором — проверка в конце
-- оператора проходит. А приём, удаляемый из-под живой заметки (каскад от
-- удаления специалиста), должен упереться в отказ, а не молча отвязать
-- протокол: SET NULL на подписанной заметке и не прошёл бы — её охраняет
-- patient_notes_immutable.
--
-- Старые строки. До этой миграции чужой приём мог попасть в заметку, а
-- подписанную заметку поправить нельзя (и не нам решать, к какому приёму она
-- на самом деле относится). Поэтому ключ заводится NOT VALID — он действует
-- для всего нового сразу — и проверяется целиком только там, где старых
-- нарушений нет (так будет почти всегда). Где они есть, ключ остаётся
-- NOT VALID, а карточка приёма такие строки не показывает (routes/clinic.ts);
-- найти их: запрос из блока ниже.
CREATE UNIQUE INDEX IF NOT EXISTS appointments_id_patient_idx ON appointments (id, patient_id);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'patient_notes_appointment_patient_fk') THEN
    ALTER TABLE patient_notes
      ADD CONSTRAINT patient_notes_appointment_patient_fk
      FOREIGN KEY (appointment_id, user_id) REFERENCES appointments (id, patient_id) NOT VALID;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM patient_notes n
     WHERE n.appointment_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.id = n.appointment_id AND a.patient_id = n.user_id)
  ) THEN
    ALTER TABLE patient_notes VALIDATE CONSTRAINT patient_notes_appointment_patient_fk;
  ELSE
    RAISE NOTICE 'patient_notes: есть заметки с чужим или несуществующим приёмом — ключ оставлен NOT VALID';
  END IF;
END $$;
--> statement-breakpoint

-- 2. Класс суперадмина выдаёт и снимает только суперадмин.
--
-- Правило живёт в lib/accountClass.ts, и оба входа (HTTP и консоль) зовут
-- его. Консоль прежде обходила его голым UPDATE — и ровно так же обошёл бы
-- его любой следующий вход, написанный мимо сервиса. Политика строк users
-- здесь не помогает: UPDATE разрешён всему персоналу (0075), иначе персонал
-- не вёл бы учётки. Поэтому последний заслон — триггер: в контексте запроса
-- сотрудника (app.role = admin или user) строка не получает класс superadmin
-- и не теряет его. Системный контекст и суперадмин проходят; без контекста
-- (владелец базы: миграции, установка, addSuperadmin, тестовые фикстуры) —
-- тоже: это не вход приложения, и кто ходит владельцем, обходит всё равно.
CREATE OR REPLACE FUNCTION users_superadmin_guard() RETURNS trigger AS $$
BEGIN
  IF (tg_op = 'INSERT' AND new.role = 'superadmin')
     OR (tg_op = 'UPDATE' AND new.role IS DISTINCT FROM old.role AND 'superadmin' IN (new.role, old.role)) THEN
    IF app_role() IS NOT NULL AND app_role() NOT IN ('system', 'superadmin') THEN
      RAISE EXCEPTION 'Класс superadmin выдаёт и снимает только суперадминистратор'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS users_superadmin_guard ON users;
--> statement-breakpoint
CREATE TRIGGER users_superadmin_guard
  BEFORE INSERT OR UPDATE OF role ON users
  FOR EACH ROW EXECUTE FUNCTION users_superadmin_guard();
