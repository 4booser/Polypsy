# ── Сборка ──────────────────────────────────────────────────────────────────
FROM oven/bun:1.4 AS build
WORKDIR /app

# слои зависимостей кэшируются отдельно от кода
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --production

COPY packages/shared packages/shared
COPY apps/api apps/api

# ── Рантайм ────────────────────────────────────────────────────────────────
FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app /app

# non-root: у образа bun уже есть пользователь bun
USER bun

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT??3001)+'/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# Только сервер. Миграции вынесены в отдельный шаг (provision.ts) намеренно:
# им нужен владелец базы, а приложение обязано подключаться ролью без прав
# владельца — иначе политики строк для него не действуют. Один контейнер не
# может быть одновременно и тем, и другим.
CMD ["bun", "apps/api/src/index.ts"]
