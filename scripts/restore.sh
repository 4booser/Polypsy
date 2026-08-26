#!/usr/bin/env bash
# Восстановление из бэкапа, созданного backup.sh, в УКАЗАННУЮ базу.
#
#   DATABASE_URL=postgres://.../quizzy_restore BACKUP_PASSPHRASE=... \
#     ./scripts/restore.sh /backups/daily/quizzy_2026-08-26_0300.dump.zst.gpg
#
# Восстанавливайте сначала в отдельную базу и проверяйте, прежде чем трогать
# рабочую: restore с --clean в живую базу — необратим.
set -euo pipefail

file="${1:?путь к файлу бэкапа}"
: "${DATABASE_URL:?DATABASE_URL обязателен}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE обязателен}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

case "$file" in
  *.age) age -d <<< "$BACKUP_PASSPHRASE" < "$file" | zstd -q -d > "$tmp" ;;
  *.gpg) gpg --batch --decrypt --passphrase "$BACKUP_PASSPHRASE" "$file" | zstd -q -d > "$tmp" ;;
  *) echo "неизвестный формат: $file" >&2; exit 1 ;;
esac

pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" "$tmp"
echo "восстановлено в $DATABASE_URL"
