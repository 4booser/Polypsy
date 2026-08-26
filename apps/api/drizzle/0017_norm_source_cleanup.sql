-- Происхождение нормы + чистка мусорных колонок.
--
-- anonymous/pseudonym попали в scale_norms и sten_rows при первоначальной
-- генерации схемы по ошибке (скопированный блок из users); никем не
-- использовались с самого начала.

ALTER TABLE scale_norms ADD COLUMN IF NOT EXISTS source text;
--> statement-breakpoint
ALTER TABLE scale_norms DROP COLUMN IF EXISTS anonymous;
--> statement-breakpoint
ALTER TABLE scale_norms DROP COLUMN IF EXISTS pseudonym;
--> statement-breakpoint
ALTER TABLE sten_rows DROP COLUMN IF EXISTS anonymous;
--> statement-breakpoint
ALTER TABLE sten_rows DROP COLUMN IF EXISTS pseudonym;
