-- Одноразовые ссылки на печатный лист прохождения (волна 14, участок mobreport).
--
-- Мобилка открывала лист (GET /api/reports/responses/:id) через
-- Linking.openURL — то есть браузером телефона, без заголовка Authorization
-- и без языка приложения. Сервер отвечал 401, а открой он лист — лист был бы
-- на языке браузера, а не приложения. Класть access-токен в адрес нельзя:
-- адрес оседает в истории браузера, в логах прокси и в заголовке Referer, а
-- токен полчаса открывает всё, что открывает его владелец.
--
-- Поэтому приложение авторизованным запросом (POST …/responses/:id/link)
-- получает ссылку на ОДИН лист, и браузер открывает её:
--   — живёт минуту (expires_at): утёкшая через историю ссылка уже мертва;
--   — открывается один раз (used_at): гашение — условием самого UPDATE, как
--     у refresh (lib/refresh.ts, claimRotation), а не проверкой прочитанного;
--   — привязана к человеку и прохождению: открывается от имени выдавшего, с
--     его зоной видимости и правилом показа результатов;
--   — хранится хешем (token_hash), как refresh: строки таблицы ссылок не дают.
-- Язык листа запоминается при выдаче (lang) — это язык приложения.
--
-- Политика строк. Выдаёт ссылку сам человек, в транзакции своего запроса, —
-- и вставить он может только ссылку на себя (user_id = app_uid()): чужую
-- ссылку от своего имени не завести даже ошибкой в коде. Читает, гасит и
-- чистит таблицу только система: гашение идёт до того, как станет известно,
-- чья это ссылка (браузер приходит без входа), а персоналу и пациенту
-- перечень чужих ссылок ни к чему. Две политики, потому что разрешающие
-- политики складываются по командам: вставка проходит по любой из двух,
-- чтение, изменение и удаление — только по системной.

CREATE TABLE IF NOT EXISTS report_links (
  id text PRIMARY KEY,
  token_hash text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  response_id text NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  lang text NOT NULL CHECK (lang IN ('uk', 'ru', 'en')),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  expires_at timestamp with time zone NOT NULL,
  used_at timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS report_links_hash_idx ON report_links (token_hash);
--> statement-breakpoint
-- чистка отживших ссылок идёт по сроку (lib/reportLinks.ts, issueReportLink)
CREATE INDEX IF NOT EXISTS report_links_expires_idx ON report_links (expires_at);
--> statement-breakpoint
ALTER TABLE report_links ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS report_links_issue ON report_links;
--> statement-breakpoint
CREATE POLICY report_links_issue ON report_links FOR INSERT WITH CHECK (
  app_role() = 'system'
  OR user_id = app_uid()
);
--> statement-breakpoint
DROP POLICY IF EXISTS report_links_system ON report_links;
--> statement-breakpoint
CREATE POLICY report_links_system ON report_links FOR ALL USING (
  app_role() = 'system'
) WITH CHECK (
  app_role() = 'system'
);
