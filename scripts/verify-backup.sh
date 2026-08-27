#!/usr/bin/env bash
# Проверка восстановимости бэкапа.
#
# «Бэкап, который ни разу не разворачивали, — не бэкап»: файл может быть
# обрезан, зашифрован потерянным ключом или содержать дамп, который не
# накатывается. Узнать об этом в день аварии — поздно.
#
# Скрипт берёт самый свежий бэкап, разворачивает его в одноразовую базу,
# сверяет, что данные на месте, проверяет цепочку журнала и удаляет базу за
# собой. Ненулевой код возврата — повод для оповещения.
#
#   DATABASE_URL=postgres://user@host/quizzy \
#   BACKUP_DIR=/backups BACKUP_PASSPHRASE=... ./scripts/verify-backup.sh
#
# В cron: раз в неделю, вывод — в систему оповещений.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL обязателен — из него берутся хост и учётные данные}"
: "${BACKUP_DIR:?BACKUP_DIR обязателен}"
: "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE обязателен}"

# самый свежий файл из суточных; если их нет — из любых
latest="$(ls -1t "$BACKUP_DIR"/daily/* 2>/dev/null | head -1 || true)"
[ -n "$latest" ] || latest="$(find "$BACKUP_DIR" -type f -name 'quizzy_*' | sort -r | head -1 || true)"
[ -n "$latest" ] || { echo "ПРОВАЛ: в $BACKUP_DIR нет ни одного бэкапа"; exit 1; }

age_hours=$(( ( $(date +%s) - $(stat -f %m "$latest" 2>/dev/null || stat -c %Y "$latest") ) / 3600 ))
echo "проверяю: $latest (возраст ${age_hours} ч)"

# свежесть — часть проверки: разворачивающийся, но недельной давности бэкап
# означает, что расписание встало
if [ "$age_hours" -gt 48 ]; then
  echo "ПРОВАЛ: самому свежему бэкапу ${age_hours} ч — расписание бэкапов не работает"
  exit 1
fi

# одноразовая база с меткой времени: параллельные прогоны не мешают друг другу
check_db="quizzy_verify_$(date +%s)"
base_url="${DATABASE_URL%/*}"
admin_url="$base_url/postgres"

cleanup() {
  psql "$admin_url" -q -c "DROP DATABASE IF EXISTS \"$check_db\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql "$admin_url" -q -c "CREATE DATABASE \"$check_db\""
DATABASE_URL="$base_url/$check_db" BACKUP_PASSPHRASE="$BACKUP_PASSPHRASE" \
  ./scripts/restore.sh "$latest" >/dev/null

restored_url="$base_url/$check_db"

fail=0
say_fail() { echo "ПРОВАЛ: $1"; fail=1; }

# 1. Ключевые таблицы существуют и непусты. Пустая таблица прохождений в
#    дампе живой системы означает, что дамп снят не с той базы.
for table in users surveys responses audit_log; do
  n="$(psql "$restored_url" -tAc "select count(*) from $table" 2>/dev/null || echo "нет")"
  if [ "$n" = "нет" ]; then
    say_fail "таблицы $table нет в восстановленной базе"
  elif [ "$n" = "0" ]; then
    say_fail "таблица $table пуста"
  else
    echo "  $table: $n строк"
  fi
done

# 2. Миграции накатаны полностью: восстановленная база должна знать столько же
#    миграций, сколько рабочая, иначе дамп снят со старой схемы.
have="$(psql "$restored_url" -tAc 'select count(*) from drizzle."__drizzle_migrations"' 2>/dev/null || echo 0)"
want="$(psql "$DATABASE_URL"  -tAc 'select count(*) from drizzle."__drizzle_migrations"' 2>/dev/null || echo 0)"
if [ "$have" != "$want" ]; then
  say_fail "миграций в бэкапе $have, в рабочей базе $want"
else
  echo "  миграций: $have"
fi

# 3. Цепочка журнала цела. Хэш-цепочка — единственное, что доказывает, что
#    журнал не переписан; если она рвётся в бэкапе, восстанавливать его в
#    качестве доказательства бессмысленно.
broken="$(psql "$restored_url" -tAc "
  with chained as (
    select seq, prev_hash, lag(entry_hash) over (order by seq) as expected
    from audit_log
  )
  select count(*) from chained where seq > 1 and prev_hash is distinct from expected
" 2>/dev/null || echo "нет")"
if [ "$broken" = "нет" ]; then
  say_fail "не удалось проверить цепочку журнала"
elif [ "$broken" != "0" ]; then
  say_fail "цепочка журнала рвётся в $broken местах"
else
  echo "  цепочка журнала: цела"
fi

if [ "$fail" != "0" ]; then
  echo
  echo "ИТОГ: бэкап непригоден. Разбираться сейчас, а не в день аварии."
  exit 1
fi

echo
echo "ИТОГ: бэкап разворачивается и проверки проходит."
