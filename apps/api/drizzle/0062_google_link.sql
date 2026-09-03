-- Связь учётной записи с Google.
--
-- Хранится sub, а не почта: почту в Google Workspace переназначают
-- уволившемуся сотруднику следующему, и вход по почте отдал бы новому
-- человеку чужую учётную запись вместе с доступом к картам.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;

-- Одна учётная запись Google соответствует одной нашей. Без этого двое
-- входят как один и оба видят карты друг друга.
CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_idx ON users (google_sub);
