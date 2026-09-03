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
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
