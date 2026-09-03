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

# ── whisper.cpp ─────────────────────────────────────────────────────────────
# Расшифровка идёт своим движком на сервере учреждения. Отправить запись
# психотерапевтической сессии в облачный сервис распознавания значит раскрыть
# её третьей стороне — ни Web Speech API, ни облачные STT сюда не годятся.
#
# Собирается из исходников, а не ставится пакетом: в репозиториях Debian его
# нет, а бинарники со стороны для такой задачи брать не хочется.
#
# GGML_NATIVE=OFF обязателен. По умолчанию сборка включает оптимизации под
# процессор сборочной машины — а образ собирается в CI и едет на VPS с
# другим процессором. Итог был бы не «медленнее», а «недопустимая
# инструкция» при первой же расшифровке, то есть отказ в бою при зелёной
# сборке.
#
# BUILD_SHARED_LIBS=OFF — потому что в рантайм переносится один файл. При
# сборке по умолчанию рядом появляются libwhisper.so и libggml*.so, и
# скопированный без них бинарник не запускается вовсе: «cannot open shared
# object file». Образ при этом собирается зелёным.
FROM debian:bookworm-slim AS whisper
ARG WHISPER_REF=v1.7.4
RUN apt-get update \
 && apt-get install -y --no-install-recommends git build-essential cmake ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${WHISPER_REF} https://github.com/ggerganov/whisper.cpp /src \
 && cmake -S /src -B /src/build -DCMAKE_BUILD_TYPE=Release \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
      -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF \
 && cmake --build /src/build --config Release -j"$(nproc)" \
 && mkdir -p /out && cp /src/build/bin/whisper-cli /out/whisper-cli

# ── Рантайм ────────────────────────────────────────────────────────────────
FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production

# libgomp нужен собранному whisper.cpp; без него бинарник не стартует
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=whisper /out/whisper-cli /usr/local/bin/whisper-cli
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
