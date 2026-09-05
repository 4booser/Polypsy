#!/bin/sh
# Запуск Caddy с приведением пустого SITE_ADDRESS к «:80».
#
# Подстановка вида {$SITE_ADDRESS::80} в Caddyfile берёт запасное значение
# только когда переменная НЕ ЗАДАНА. Заданная пустой — а именно так она
# стоит в примере окружения, пока домена ещё нет, — подставляется пустотой,
# файл начинается с «{», и Caddy читает его как блок глобальных настроек:
# «unrecognized global option: encode». Консоль не поднималась вовсе — ровно
# в первом сценарии, до покупки домена, по IP.
#
# Отдельным файлом, а не heredoc внутри Dockerfile: heredoc в COPY требует
# BuildKit, а на сервере вполне может работать классический сборщик — там
# сборка падает с «COPY failed: no source files were specified».
set -e
[ -z "$SITE_ADDRESS" ] && export SITE_ADDRESS=":80"

# Почта учётной записи ACME дописывается блоком глобальных настроек, и только
# когда она задана. Пустое значение здесь — не то же, что отсутствие строки:
# `email` без аргумента Caddy отвергает целиком («wrong argument count»), и
# конфиг не разбирается вовсе — тот же класс ошибки, что с пустым
# SITE_ADDRESS выше, и проверять его надо так же, запуском образа.
CONFIG=/etc/caddy/Caddyfile
if [ -n "$ACME_EMAIL" ]; then
  CONFIG=/tmp/Caddyfile
  printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL" > "$CONFIG"
  cat /etc/caddy/Caddyfile >> "$CONFIG"
fi

exec caddy run --config "$CONFIG" --adapter caddyfile
