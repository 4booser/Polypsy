#!/usr/bin/env bash
# Восстановление из бэкапа, созданного backup.sh, в УКАЗАННУЮ базу.
#
#   DATABASE_URL=postgres://.../quizzy_restore BACKUP_PASSPHRASE=... \
#     ./scripts/restore.sh /backups/daily/quizzy_2026-08-26_0300.dump.zst.gpg
#
# Восстанавливайте сначала в отдельную базу и проверяйте, прежде чем трогать
# рабочую: restore с --clean в живую базу — необратим.
set -euo pipefail

# Клиентские утилиты берутся той же версии, что и сервер.
#
# PG_EXEC — префикс запуска. Пусто: pg_dump с хоста. В развёртывании через
# Docker сюда ставится «docker compose exec -T postgres», и тогда дамп
# снимает тот же PostgreSQL, который хранит данные.
#
# Это не аккуратность ради аккуратности. На сервере оказался pg_dump 18 при
# базе 16 — сочетание неподдерживаемое: дамп получается, но несёт
# «SET transaction_timeout», которого шестнадцатая версия не знает, и
# восстановление идёт с ошибками. Заметно это только при восстановлении,
# то есть в тот единственный момент, когда бэкап и нужен.
PG_EXEC="${PG_EXEC:-}"


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

# Дамп подаётся на вход, а не именем файла: при PG_EXEC="docker compose exec"
# pg_restore работает внутри контейнера, где хостового пути не существует.
$PG_EXEC pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" < "$tmp"
echo "восстановлено в $DATABASE_URL"
