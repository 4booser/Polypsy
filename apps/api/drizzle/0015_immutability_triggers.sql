-- Неизменяемость клинических данных на уровне БД.
--
-- Прикладной код уже соблюдает эти правила; триггеры делают их непреложными
-- и для прямого SQL: скомпрометированное приложение или неосторожный DBA
-- физически не могут переписать журнал или подписанное заключение.
--
-- Служебный обход (бэкфилл шифрования) включается на сессию через
-- set_config('app.maintenance', '1', false) — и виден в логах Postgres.

CREATE OR REPLACE FUNCTION forbid_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log неизменяем: % запрещён', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION forbid_signed_conclusion_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.maintenance', true) = '1' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'подписанное заключение неизменяемо (версия %)', OLD.version
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS conclusions_signed_immutable ON conclusions;
--> statement-breakpoint
CREATE TRIGGER conclusions_signed_immutable
  BEFORE UPDATE OR DELETE ON conclusions
  FOR EACH ROW EXECUTE FUNCTION forbid_signed_conclusion_mutation();
