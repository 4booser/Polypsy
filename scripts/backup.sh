#!/usr/bin/env bash
# Бэкап базы Quizzy: pg_dump → сжатие → шифрование → ротация.
#
# Использование:
#   DATABASE_URL=postgres://... BACKUP_DIR=/backups BACKUP_PASSPHRASE=... ./scripts/backup.sh
#
# Ротация: 7 суточных, 4 недельных (воскресенье), 12 месячных (1-е число).
# Шифрование: age при наличии, иначе gpg. Без парольной фразы скрипт падает —
# незашифрованный дамп медицинской базы на диске недопустим.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL обязателен}"
: "${BACKUP_DIR:?BACKUP_DIR обязателен}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE обязателен — дампы шифруются всегда}"

stamp="$(date +%Y-%m-%d_%H%M%S)"
day_of_week="$(date +%u)"   # 7 = воскресенье
day_of_month="$(date +%d)"

kind="daily"
[ "$day_of_week" = "7" ] && kind="weekly"
[ "$day_of_month" = "01" ] && kind="monthly"

dest="$BACKUP_DIR/$kind"
mkdir -p "$dest"
out="$dest/quizzy_${stamp}.dump.zst"

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

# custom-формат pg_dump: селективное восстановление и параллельный restore
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
$PG_EXEC pg_dump --format=custom --compress=0 "$DATABASE_URL" > "$tmp"

if command -v age >/dev/null; then
  zstd -q -c "$tmp" | age -e -p > "$out.age" <<< "$BACKUP_PASSPHRASE" 2>/dev/null \
    || AGE_PASSPHRASE="$BACKUP_PASSPHRASE" zstd -q -c "$tmp" | age -e -p > "$out.age"
  final="$out.age"
else
  zstd -q -c "$tmp" | gpg --batch --yes --symmetric --passphrase "$BACKUP_PASSPHRASE" -o "$out.gpg"
  final="$out.gpg"
fi

echo "бэкап: $final ($(du -h "$final" | cut -f1))"

# ротация
prune() { # dir keep
  [ -d "$1" ] || return 0
  ls -1t "$1" | tail -n "+$(( $2 + 1 ))" | while read -r f; do rm -f "$1/$f"; done
}
prune "$BACKUP_DIR/daily" 7
prune "$BACKUP_DIR/weekly" 4
prune "$BACKUP_DIR/monthly" 12
