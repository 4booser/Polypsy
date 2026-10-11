#!/usr/bin/env bash
# Предел ядер расшифровщика — не больше, чем ядер у хоста (#158).
#
#   scripts/transcriber-cpus.sh [<файл окружения>]   (по умолчанию .env.docker)
#
# docker-compose.yml ограничивает transcriber числом TRANSCRIBER_CPUS (по
# умолчанию 2). Предел больше числа ядер Docker не принимает вовсе: контейнер
# не создаётся, и вместе с ним встаёт весь `up` — на одноядерном сервере
# падали и установка, и выкатка. Скрипт сверяет значение из файла (или
# умолчание compose, если в файле его нет) с числом ядер и, если оно больше,
# записывает в файл число ядер. Меньшее или равное не трогает.
#
# Зовут его vps-setup.sh перед первым `up` и выкатка (deploy.yml) перед
# подменой версии: сервер могли пересадить на машину поменьше.
#
# HOST_CPUS — подмена числа ядер для проверки (test/composeEnv.test.ts).
set -euo pipefail
# во временный файл ложится .env.docker с секретами — только владельцу
umask 077

file="${1:-.env.docker}"
[ -f "$file" ] || { echo "нет файла окружения: $file" >&2; exit 1; }

host="${HOST_CPUS:-$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN)}"
want="$(sed -n 's/^TRANSCRIBER_CPUS=//p' "$file" | tail -n 1 | tr -d '[:space:]"'"'")"
# умолчание — то же, что в docker-compose.yml
want="${want:-2}"

if ! [[ "$want" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "TRANSCRIBER_CPUS=$want — не число; ожидается, например, 1 или 1.5" >&2
  exit 1
fi

if awk -v w="$want" -v h="$host" 'BEGIN { exit !(w + 0 > h + 0) }'; then
  if grep -q '^TRANSCRIBER_CPUS=' "$file"; then
    # awk, а не sed -i: у GNU и BSD sed разный синтаксис -i
    awk -v v="$host" 'BEGIN{FS=OFS="="} $1=="TRANSCRIBER_CPUS"{print "TRANSCRIBER_CPUS=" v; next} {print}' \
      "$file" > "$file.tmp" && cat "$file.tmp" > "$file" && rm -f "$file.tmp"
  else
    printf 'TRANSCRIBER_CPUS=%s\n' "$host" >> "$file"
  fi
  echo "TRANSCRIBER_CPUS=$want больше числа ядер сервера ($host) — записано $host"
else
  echo "TRANSCRIBER_CPUS=$want: ядер у сервера $host — предел допустим"
fi
