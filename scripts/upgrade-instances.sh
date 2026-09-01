#!/usr/bin/env bash
#
# Обновление нескольких экземпляров.
#
# Каждое учреждение живёт в своей базе, и обновлять их по одному руками —
# это ровно та работа, где на пятом забывают шаг. Скрипт делает один и тот
# же порядок для каждого и останавливается на первом отказе.
#
# Порядок не случаен:
#   1. снимок базы — до всего, потому что откатывать нечем, если его нет;
#   2. миграции;
#   3. проверка, что приложение поднимается на новой схеме;
#   4. и только потом следующий экземпляр.
#
# Останавливается на первом отказе намеренно. Продолжить и обновить
# остальные значило бы получить пять учреждений в разных состояниях, из
# которых неизвестно какое рабочее.
#
#   INSTANCES=/etc/quizzy/instances.txt BACKUP_DIR=/backups ./scripts/upgrade-instances.sh
#
# Файл instances.txt — по строке на экземпляр:
#   hospital1  postgres://quizzy_app:…@localhost/quizzy_hospital1
#   hospital2  postgres://quizzy_app:…@localhost/quizzy_hospital2

set -euo pipefail

INSTANCES="${INSTANCES:-./instances.txt}"
BACKUP_DIR="${BACKUP_DIR:-}"

if [[ ! -f "$INSTANCES" ]]; then
  echo "Не найден список экземпляров: $INSTANCES" >&2
  exit 1
fi

if [[ -z "$BACKUP_DIR" ]]; then
  # Снимок обязателен, а не «желателен»: миграция, которая не откатывается,
  # без снимка означает потерянные клинические записи.
  echo "BACKUP_DIR не задан. Обновление без снимка базы не запускается." >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

total=0
done_count=0

while read -r name url; do
  [[ -z "${name:-}" || "${name:0:1}" == "#" ]] && continue
  total=$((total + 1))

  echo
  echo "── $name ──"

  stamp="$(date +%Y%m%d-%H%M%S)"
  dump="$BACKUP_DIR/$name-$stamp.sql.gz"

  echo "  снимок → $dump"
  if ! pg_dump "$url" | gzip > "$dump"; then
    echo "  ОТКАЗ: снимок не сделан. Остальные экземпляры не трогаем." >&2
    exit 1
  fi
  # Пустой снимок — это не снимок. Проверяем размер, а не код возврата:
  # pg_dump на недоступной базе иногда выходит нулём с пустым выводом.
  if [[ ! -s "$dump" ]]; then
    echo "  ОТКАЗ: снимок пуст." >&2
    exit 1
  fi

  echo "  миграции"
  if ! DATABASE_URL="$url" bun run --cwd apps/api db:migrate; then
    echo "  ОТКАЗ на миграциях. Снимок здесь: $dump" >&2
    exit 1
  fi

  # Проверка, что приложение поднимается на новой схеме. Без неё «миграции
  # прошли» означает только «SQL выполнился»: несовпадение схемы и кода
  # вылезет у первого пользователя, а не здесь.
  echo "  проверка запуска"
  if ! DATABASE_URL="$url" bun run --cwd apps/api install:instance > /dev/null; then
    echo "  ОТКАЗ: приложение не поднимается на новой схеме. Снимок: $dump" >&2
    exit 1
  fi

  done_count=$((done_count + 1))
  echo "  готово"
done < "$INSTANCES"

echo
echo "Обновлено: $done_count из $total."
if [[ "$done_count" -ne "$total" ]]; then
  echo "Не все экземпляры обработаны — смотрите вывод выше." >&2
  exit 1
fi
