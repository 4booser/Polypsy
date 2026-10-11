#!/usr/bin/env bash
# Оповещение с хоста в канал техпанели (#159).
#
#   scripts/ops-alert.sh "<что случилось>"
#   scripts/ops-alert.sh --unit <служба>   из OnFailure= (quizzy-alert@.service)
#
# Запускается из каталога установки (там docker-compose.yml и .env.docker):
# так его зовут служба оповещения (WorkingDirectory) и backup.sh.
#
# Зачем. Копии снимает и проверяет хост — службы quizzy-backup и
# quizzy-verify, — а оповещения техпанели живут в приложении, которое о них
# не знает. Прежде упавшая ночная копия или проверка восстановимости не
# говорила никому: об этом узнавали в лучшем случае из ежемесячного прогона.
#
# Два пути, по порядку:
#   1. Через приложение: `docker compose exec -T api bun
#      apps/api/src/opsNotify.ts` — те же каналы, что у правил техпанели
#      (Telegram и почта), настроенные в .env.docker.
#   2. Если приложение не ответило или ни один его канал не принял —
#      прямо в Telegram с хоста, токеном и чатом из того же .env.docker:
#      копия часто падает ровно тогда, когда лежит и сам стек.
# Код выхода 0 — ушло хоть куда-то; 1 — никуда (причина — в выводе).
#
# Текст — украинский, как у остальных оповещений техпанели: их читают
# дежурные и администратор учреждения. Данных в нём нет — только что
# случилось и где смотреть журнал.
#
# TELEGRAM_API — адрес API Telegram; подменяется в проверке
# (scripts/test/offsite-roundtrip.sh).
set -euo pipefail

host="$(hostname 2>/dev/null || echo сервер)"
if [ "${1:-}" = "--unit" ]; then
  unit="${2:?--unit: укажите службу}"
  case "$unit" in
    quizzy-backup*) what="нічна копія бази" ;;
    quizzy-verify*) what="перевірка відновлюваності копії" ;;
    *)              what="служба $unit" ;;
  esac
  subject="Збій: $what ($unit) завершилась з помилкою"
  text="Сервер $host. Журнал: journalctl -u $unit -n 50"
else
  subject="${1:-}"
  text="${2:-Сервер $host}"
fi
[ -n "$subject" ] || { sed -n '2,5p' "$0" >&2; exit 2; }

env_file=".env.docker"
from_env() { # ключ — значение из .env.docker, без кавычек
  [ -f "$env_file" ] || return 0
  sed -n "s/^$1=//p" "$env_file" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# 1. Через приложение. -T и </dev/null: скрипт зовут и из удалённых
# сценариев выкатки, пришедших через stdin, — exec без них съел бы их остаток.
if [ -f docker-compose.yml ] && [ -f "$env_file" ] && command -v docker >/dev/null 2>&1; then
  if out="$(docker compose --env-file "$env_file" exec -T api bun apps/api/src/opsNotify.ts "$subject" "$text" </dev/null 2>&1)"; then
    echo "оповещение ушло через приложение: $(printf '%s' "$out" | tr '\n' ' ')"
    exit 0
  fi
  echo "приложение оповещение не отправило: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')" >&2
fi

# 2. Прямо в Telegram. Токен — в адресе запроса, поэтому адрес идёт через
# конфиг на дескрипторе, а не аргументом: аргументы видны в ps.
token="$(from_env TELEGRAM_BOT_TOKEN)"
chat="$(from_env TELEGRAM_CHAT_ID)"
if [ -z "$token" ] || [ -z "$chat" ]; then
  echo "оповещение не ушло: приложение не ответило, а Telegram в $env_file не настроен (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)" >&2
  exit 1
fi
api="${TELEGRAM_API:-https://api.telegram.org}"
if curl --silent --show-error --fail --max-time 20 --output /dev/null \
     --config /dev/fd/3 \
     --data-urlencode "chat_id=$chat" \
     --data-urlencode "text=$subject
$text" \
     3<<<"url = \"${api%/}/bot$token/sendMessage\"" 2>/dev/null; then
  echo "оповещение ушло в Telegram с хоста"
  exit 0
fi
echo "оповещение не ушло: Telegram отказал или не ответил" >&2
exit 1
