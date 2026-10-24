-- Направления методик и наборы-заготовки общего каталога (каталог 2.1, участок catalog-infra).
--
-- ═══ surveys.domain: «что измеряет» ═══
--
-- Каталог прирастает полутора-двумя десятками методик за волну, и одной
-- лентой его уже не читают. Папки сюда не годятся: папка принадлежит группе
-- (survey_folders.group_id NOT NULL), а методики общего каталога ставятся без
-- группы — положить их в папку нельзя. Направление — свойство самой
-- методики, одно на все учреждения: у методики каталога его ставит
-- установщик по карте apps/api/src/instruments/catalogDomains.ts (как
-- настройку каталога — правку учреждения обновление сохраняет), у
-- заведённой в учреждении — конструктор.
--
-- Перечень — тот же, что SURVEY_DOMAINS (packages/shared/src/domains.ts), и
-- держит его база: опечатка в карте каталога или в чужом скрипте упирается в
-- ограничение, а не ложится в каталог направлением, которого нет ни в одном
-- чипе. Новое направление — новая миграция. NULL — не выбрано.
--
-- Индекса нет намеренно: методик в учреждении сотни, фильтр по направлению
-- идёт вместе с зоной видимости и статусом, и отдельный индекс по десяти
-- значениям план не выберет.
ALTER TABLE surveys ADD COLUMN IF NOT EXISTS domain text;
--> statement-breakpoint
ALTER TABLE surveys DROP CONSTRAINT IF EXISTS surveys_domain_check;
--> statement-breakpoint
ALTER TABLE surveys ADD CONSTRAINT surveys_domain_check CHECK (
  domain IS NULL OR domain IN (
    'distress', 'trauma', 'suicide', 'sleep', 'addiction',
    'wellbeing', 'cognitive', 'personality', 'staff', 'other'
  )
);
--> statement-breakpoint

-- ═══ batteries.catalog_key: заготовка, заведённая установщиком ═══
--
-- Наборы-заготовки (apps/api/src/instruments/catalogBatteries.ts) установщик
-- заводит один раз — общими (group_id NULL), — и дальше ими распоряжается
-- отделение. Ключ — то, по чему установщик узнаёт уже заведённую заготовку на
-- следующем выкате; название для этого не годится: его вправе изменить
-- отделение, и выкат завёл бы второй набор. Уникальный индекс держит одну
-- строку на ключ и против двух установщиков, запущенных разом (выкат и ручная
-- задача техпанели); пустые ключи наборов учреждения друг другу не мешают —
-- NULL в уникальном индексе не равен NULL.
ALTER TABLE batteries ADD COLUMN IF NOT EXISTS catalog_key text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS batteries_catalog_key_idx ON batteries (catalog_key);
