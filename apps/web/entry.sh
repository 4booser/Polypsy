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

# Пустые дополнительные имена должны исчезнуть из строки адресов совсем.
# Заданная пустой переменная подставляется пустотой — сама по себе это не
# беда, но проверять надо запуском образа в обоих состояниях: ровно на этом
# месте уже дважды ломался разбор конфига (пустой SITE_ADDRESS, пустой
# ACME_EMAIL), и оба раза «выглядит правильно» оказывалось неверным.
export SITE_ALIASES="${SITE_ALIASES:-}"

# Почта учётной записи ACME дописывается блоком глобальных настроек, и только
# когда она задана. Пустое значение здесь — не то же, что отсутствие строки:
# `email` без аргумента Caddy отвергает целиком («wrong argument count»), и
# конфиг не разбирается вовсе — тот же класс ошибки, что с пустым
# SITE_ADDRESS выше, и проверять его надо так же, запуском образа.
# Адрес сайта для страниц, которые читают поисковики и AI-ассистенты:
# og:url, og:image и разметка schema.org в index.html, строка Sitemap в
# robots.txt и сама карта сайта. Ссылки там обязаны быть полными, а домен у
# каждого учреждения свой — поэтому он подставляется здесь, при старте, а не
# зашивается в образ. Без домена (адрес «:80», запуск по IP) ссылки остаются
# относительными, и карты сайта нет: давать в ней чужой или пустой адрес
# хуже, чем не давать её вовсе. Подстановка повторному запуску не мешает:
# второй раз заменять уже нечего.
first="${SITE_ADDRESS%% *}"
first="${first%%,*}"
case "$first" in
  http://*|https://*) SITE_URL="${first%/}" ;;
  :*|localhost|localhost:*) SITE_URL="" ;;
  *.*) SITE_URL="https://$first" ;;
  *) SITE_URL="" ;;
esac
for page in /srv/index.html /srv/app.html; do
  if [ -f "$page" ]; then sed -i "s|%SITE_URL%|$SITE_URL|g" "$page"; fi
done
if [ -n "$SITE_URL" ]; then
  grep -q '^Sitemap:' /srv/robots.txt || printf '\nSitemap: %s/sitemap.xml\n' "$SITE_URL" >> /srv/robots.txt
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>%s/</loc></url>\n  <url><loc>%s/llms.txt</loc></url>\n</urlset>\n' "$SITE_URL" "$SITE_URL" > /srv/sitemap.xml
fi

CONFIG=/etc/caddy/Caddyfile
if [ -n "$ACME_EMAIL" ]; then
  CONFIG=/tmp/Caddyfile
  printf '{\n\temail %s\n}\n\n' "$ACME_EMAIL" > "$CONFIG"
  cat /etc/caddy/Caddyfile >> "$CONFIG"
fi

exec caddy run --config "$CONFIG" --adapter caddyfile
