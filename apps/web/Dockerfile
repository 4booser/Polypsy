# ── Сборка статики ──────────────────────────────────────────────────────────
FROM oven/bun:1.4 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN cd apps/web && bun run build

# ── Раздача ────────────────────────────────────────────────────────────────
FROM caddy:2-alpine
COPY --from=build /app/apps/web/dist /srv
COPY apps/web/Caddyfile /etc/caddy/Caddyfile

# Пустой SITE_ADDRESS приводится к «:80» здесь, а не в Caddyfile.
#
# Подстановка вида {$SITE_ADDRESS::80} берёт запасное значение только когда
# переменная НЕ ЗАДАНА. Заданная пустой — а именно так она стоит в примере
# окружения, пока домена ещё нет, — подставляется пустотой, файл начинается
# с «{», и Caddy читает его как блок глобальных настроек: «unrecognized
# global option: encode». Консоль не поднималась вовсе — ровно в первом
# сценарии, до покупки домена, по IP.
COPY <<'SH' /usr/local/bin/entry.sh
#!/bin/sh
set -e
[ -z "$SITE_ADDRESS" ] && export SITE_ADDRESS=":80"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
SH
RUN chmod +x /usr/local/bin/entry.sh
CMD ["/usr/local/bin/entry.sh"]
