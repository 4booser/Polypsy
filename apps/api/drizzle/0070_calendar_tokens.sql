-- Подключение календаря специалиста для дистанционного приёма.
--
-- Ссылку на встречу Google Meet нельзя придумать: код вида
-- `abc-defg-hij` выдаёт сам Google при создании события в календаре. Любая
-- самодельная ссылка ведёт в никуда, а «дистанционный приём» со ссылкой,
-- которая не открывается, хуже, чем без ссылки: человек в назначенное время
-- будет стучаться в закрытую дверь и решит, что его не приняли.
--
-- Поэтому здесь хранится разрешение специалиста создавать события в ЕГО
-- календаре — отдельно от входа через Google, и вот почему отдельно:
--
--   • вход просит `openid email profile` и не получает refresh-токена
--     вовсе; для создания событий нужен offline-доступ, а он выдаётся один
--     раз и живёт, пока его не отозвали;
--   • право писать в календарь несопоставимо чувствительнее права узнать
--     почту, и подмешивать его к входу значило бы просить всех и сразу за
--     то, что нужно немногим.
--
-- Токен шифруется тем же ключом, что клинические записи: это ключ от
-- календаря живого человека.
CREATE TABLE IF NOT EXISTS google_calendar_tokens (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_enc text NOT NULL,
  google_email text,
  connected_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE google_calendar_tokens ENABLE ROW LEVEL SECURITY;

-- Свой токен видит только его владелец; система — для фоновых задач.
CREATE POLICY google_calendar_tokens_self ON google_calendar_tokens
  USING (current_setting('app.role', true) = 'system'
         OR user_id = current_setting('app.user_id', true));
CREATE POLICY google_calendar_tokens_write ON google_calendar_tokens
  FOR ALL
  USING (current_setting('app.role', true) = 'system'
         OR user_id = current_setting('app.user_id', true))
  WITH CHECK (current_setting('app.role', true) = 'system'
         OR user_id = current_setting('app.user_id', true));
