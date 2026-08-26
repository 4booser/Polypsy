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
