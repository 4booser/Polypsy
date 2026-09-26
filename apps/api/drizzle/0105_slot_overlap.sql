-- Открытые слоты одного специалиста не пересекаются по времени (волна 12,
-- участок clinic; решение заказчика 2026-09-26 по внешнему разбору).
--
-- ═══ Что было ═══
--
-- Синхронизация сетки (lib/schedule.ts, syncSlots) узнавала «свой» слот по
-- одному началу: единственный ключ — (specialist_id, starts_at). Смена
-- длительности 50 → 30 минут оставляла 09:00–09:50 — начало совпало, вставка
-- молча ничего не делала, — и рядом появлялся 09:30–10:00. Оба открыты для
-- записи, и два человека попадали к одному специалисту на одни и те же
-- двадцать минут. Код теперь сверяет слот по обоим концам, но база должна
-- держать правило сама: то же рассуждение, что у ключа `on delete restrict`
-- в 0064, — защита в коде живёт в том самом окне между чтением и записью,
-- которое должна закрывать.
--
-- ═══ Почему «открытые», а не «свободные» ═══
--
-- Занятость в слоте не хранится (routes/clinic.ts, «Занятость считается
-- здесь»), и условием ограничения её не выразить. Зато выразимо более
-- сильное правило: открытый слот — это обещание времени специалиста,
-- свободное или уже отданное, и два таких обещания на одно время не бывают.
-- Закрытый слот (status = 'closed') — история: так синхронизация уводит из
-- сетки слот, на котором лежит отменённый приём. Удалить его нельзя (ключ
-- 0064), а держать открытым — значит держать занятым чужое время.
--
-- Ограничение требует btree_gist (равенство по тексту в gist-индексе).
-- Расширение доверенное с PostgreSQL 13 и входит в официальный образ
-- postgres:16 (docker-compose.yml, CI). Если создать его не удалось, миграция
-- не падает — её отказ остановил бы выкатку целиком, — а предупреждает, и
-- правило остаётся на коде (syncSlots сама не вставляет пересечений, takeSlot
-- не записывает в закрытый слот). Проверка slotGrid.test.ts упадёт в такой
-- среде: без базы это правило неполное, и это должно быть видно.

/* ── разбор уже накопленных пересечений ──
   Без него ограничение не создать: прежняя синхронизация успела их
   наплодить. Порядок — от безобидного к заметному, и приём не удаляется и
   не меняет времени ни на одном шаге.

   1. Слот, на котором не было ни одного приёма, перекрывающий занятый или
      более новый слот, удаляется. «Новее» — потому что новый слот построен
      по нынешнему шаблону, а старый — по прежнему: в случае 50 → 30 уходит
      09:00–09:50 и остаётся 09:30–10:00. Недостающий 09:00–09:30 вернёт
      первая же синхронизация (любая правка расписания).
   2. Слот только с отменёнными приёмами — то же условие, но закрывается, а
      не удаляется: на нём история.
   3. Остаются пересечения, где на обоих слотах живые приёмы, — двойная
      запись, случившаяся до правки. Решать за людей, кого из двоих
      снимать, миграция не вправе: более новый из пары закрывается для
      записи (его приём живёт как жил) и помечается «вне расписания», чтобы
      специалист увидел его в своём дне. Число таких слотов — в
      предупреждении миграции. */
DO $$
DECLARE
  n_deleted integer;
  n_closed integer;
  n_double integer;
BEGIN
  DELETE FROM slots s
  WHERE s.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id)
    AND EXISTS (
      SELECT 1 FROM slots o
      WHERE o.specialist_id = s.specialist_id
        AND o.id <> s.id
        AND o.status = 'open'
        AND tstzrange(o.starts_at, o.ends_at) && tstzrange(s.starts_at, s.ends_at)
        AND (
          EXISTS (SELECT 1 FROM appointments b WHERE b.slot_id = o.id AND b.status <> 'cancelled')
          OR (o.created_at, o.id) > (s.created_at, s.id)
        )
    );
  GET DIAGNOSTICS n_deleted = ROW_COUNT;

  UPDATE slots s SET status = 'closed'
  WHERE s.status = 'open'
    AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.slot_id = s.id AND a.status <> 'cancelled')
    AND EXISTS (
      SELECT 1 FROM slots o
      WHERE o.specialist_id = s.specialist_id
        AND o.id <> s.id
        AND o.status = 'open'
        AND tstzrange(o.starts_at, o.ends_at) && tstzrange(s.starts_at, s.ends_at)
        AND (
          EXISTS (SELECT 1 FROM appointments b WHERE b.slot_id = o.id AND b.status <> 'cancelled')
          OR (o.created_at, o.id) > (s.created_at, s.id)
        )
    );
  GET DIAGNOSTICS n_closed = ROW_COUNT;

  UPDATE slots s SET status = 'closed', off_schedule = true
  WHERE s.status = 'open'
    AND EXISTS (
      SELECT 1 FROM slots o
      WHERE o.specialist_id = s.specialist_id
        AND o.id <> s.id
        AND o.status = 'open'
        AND tstzrange(o.starts_at, o.ends_at) && tstzrange(s.starts_at, s.ends_at)
        AND (o.created_at, o.id) < (s.created_at, s.id)
    );
  GET DIAGNOSTICS n_double = ROW_COUNT;

  IF n_deleted + n_closed > 0 THEN
    RAISE NOTICE 'slots: пересечения разобраны — удалено %, закрыто %', n_deleted, n_closed;
  END IF;
  IF n_double > 0 THEN
    RAISE WARNING 'slots: % слотов с живыми приёмами пересекались с другими — закрыты для записи и помечены «вне расписания»', n_double;
  END IF;
END
$$;
--> statement-breakpoint

/* ── ключ начала — только среди открытых ──
   Закрытый слот 09:00–09:50 с отменённым приёмом не должен мешать новому
   09:00–09:30: история не держит время. Ключ остаётся — на нём
   идемпотентность вставки и страховка, если ограничение ниже не создано. */
DROP INDEX IF EXISTS slots_specialist_start_uniq;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS slots_specialist_start_uniq
  ON slots (specialist_id, starts_at) WHERE status = 'open';
--> statement-breakpoint

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS btree_gist;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'btree_gist не создано, пересечения слотов держит только код: %', SQLERRM;
END
$$;
--> statement-breakpoint

/* ── само правило ──
   Интервал полуоткрытый ('[)' — умолчание tstzrange): 09:00–09:30 и
   09:30–10:00 стоят впритык и не пересекаются. */
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist')
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slots_open_no_overlap') THEN
    ALTER TABLE slots
      ADD CONSTRAINT slots_open_no_overlap
      EXCLUDE USING gist (specialist_id WITH =, tstzrange(starts_at, ends_at) WITH &&)
      WHERE (status = 'open');
  END IF;
END
$$;
