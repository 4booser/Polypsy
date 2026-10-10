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

# ── ffmpeg только для звука ────────────────────────────────────────────────
# Браузер пишет приём в WebM/Opus (Chrome, Firefox), Ogg (Firefox) или
# MP4/AAC (Safari), а whisper.cpp без своей сборки с FFmpeg читает только
# WAV. Прежде байты WebM уходили в whisper как есть: он писал «failed to read»
# в stderr, выходил с кодом 0 — и в карту ложилась пустая «успешная»
# стенограмма. Расшифровщик теперь переводит запись в WAV 16 кГц моно
# (lib/recordings.ts, toWav).
#
# Своя сборка, а не пакет Debian: пакет ffmpeg тянет за собой видеокодеки,
# X11 и звуковые серверы — образ вырос бы с 332 до 903 МБ (проверено). Здесь
# — только разбор этих четырёх контейнеров, их аудиокодеки, пересчёт частоты
# и WAV на выходе: статический бинарник на ~4 МБ. Сети, устройств и
# видео в нём нет вовсе, так что и разбирать чужой файл ему почти нечем.
#
# nasm — ассемблерные вставки под x86 (CI собирает amd64); без него
# configure падает. Проверено на amd64 и arm64: WebM/Opus, Ogg/Opus,
# MP4/AAC, WebM/Vorbis и WAV переводятся, мусор — отказ с кодом 183.
FROM debian:bookworm-slim AS ffmpeg
ARG FFMPEG_REF=n7.1.1
RUN apt-get update \
 && apt-get install -y --no-install-recommends git build-essential ca-certificates nasm \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${FFMPEG_REF} https://github.com/FFmpeg/FFmpeg /src \
 && cd /src \
 && ./configure --disable-everything --disable-autodetect --disable-doc --disable-debug \
      --disable-network --disable-ffplay --disable-ffprobe --disable-shared --enable-static \
      --enable-protocol=file \
      --enable-demuxer=matroska,ogg,mov,wav \
      --enable-decoder=opus,vorbis,aac,pcm_s16le,pcm_s24le,pcm_f32le \
      --enable-parser=opus,vorbis,aac \
      --enable-encoder=pcm_s16le --enable-muxer=wav \
      --enable-filter=aresample,aformat,anull,atrim \
 && make -j"$(nproc)" ffmpeg \
 && mkdir -p /out && cp ffmpeg /out/ffmpeg

# ── Рантайм ────────────────────────────────────────────────────────────────
FROM oven/bun:1.4-slim
WORKDIR /app
ENV NODE_ENV=production

# libgomp нужен собранному whisper.cpp; без него бинарник не стартует
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

COPY --from=whisper /out/whisper-cli /usr/local/bin/whisper-cli
COPY --from=ffmpeg /out/ffmpeg /usr/local/bin/ffmpeg
COPY --from=build /app /app

# Каталог записей приёмов — с владельцем bun и до USER.
#
# Сюда монтируется именованный том recordings (api, transcriber, provision).
# Пустой том Docker наполняет из образа вместе с владельцем и правами
# каталога; когда каталога в образе не было, том рождался root:root 755, а
# процесс работает под bun — storeAudio падал с EACCES, загрузка записи
# отвечала 500, разговор оставался только в браузере, таблица записей на
# сервере пустовала (#157). Непустой том, уже созданный на сервере, образ не
# чинит: его владельца правит выкатка (deploy.yml, перед up -d).
#
# 700: внутри — зашифрованные записи разговоров, и читать их, кроме самого
# приложения, некому.
RUN mkdir -p /data/recordings \
 && chown bun:bun /data/recordings \
 && chmod 700 /data/recordings

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
