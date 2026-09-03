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

# Пустой SITE_ADDRESS приводится к «:80» в entry.sh — пояснение там же.
#
# Скрипт лежит файлом, а не heredoc внутри COPY: heredoc требует BuildKit, а
# на сервере вполне может работать классический сборщик — там сборка падает
# с «COPY failed: no source files were specified», и падает уже в бою.
COPY apps/web/entry.sh /usr/local/bin/entry.sh
RUN chmod +x /usr/local/bin/entry.sh
CMD ["/usr/local/bin/entry.sh"]
