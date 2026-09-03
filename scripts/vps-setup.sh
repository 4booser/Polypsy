#!/usr/bin/env bash
# Установка экземпляра на чистый сервер.
#
#   sudo ./scripts/vps-setup.sh polypsy.ink
#
# Делает три вещи, которые иначе делаются пятнадцатью командами по памяти:
# ставит Docker, заводит .env.docker со случайными паролями и поднимает стек.
#
# Идемпотентен: повторный запуск не трогает уже заведённое окружение и не
# перегенерирует пароли. Это важнее, чем кажется: перегенерация ENCRYPTION_KEY
# на работающем экземпляре означает, что все зашифрованные поля больше не
# читаются — ни ФИО, ни заключения, ни свободные ответы.
set -euo pipefail

DOMAIN="${1:-}"
ENV_FILE=".env.docker"

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

[ -f docker-compose.yml ] || die "Запускать из каталога с проектом."

# ── 1. Docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  say "Ставлю Docker…"
  # Скрипт get.docker.com покрывает Debian, Ubuntu, RHEL и родственников, но
  # не Arch: там он отвечает «Unsupported distribution» и выходит. А дешёвые
  # VPS нередко раздают именно Arch, и упереться в это в середине установки —
  # значит выяснять причину вместо развёртывания.
  if command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm --needed docker docker-compose git
    systemctl enable --now docker
  elif command -v apt-get >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker 2>/dev/null || true
  else
    die "Не знаю, как поставить Docker в этой системе. Поставьте его сами и запустите скрипт снова."
  fi
else
  say "Docker уже стоит: $(docker --version)"
fi

# Ждём сокет: systemctl enable --now возвращается раньше, чем демон готов
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 2; done
docker info >/dev/null 2>&1 || die "Демон Docker не поднялся: systemctl status docker"

docker compose version >/dev/null 2>&1 || die "Нужен docker compose v2 (плагин compose)."

# ── 2. Окружение ─────────────────────────────────────────────────────────────
# Пароли попадают в строку подключения вида postgres://user:ПАРОЛЬ@host/db,
# то есть в URL. Обычный base64 даёт «/» и «+»: первый обрывает адрес на
# месте пароля, второй читается как пробел. Отсюда алфавит base64url — те же
# 64 символа, но безопасные в URL.
rnd() { head -c "$1" /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n='; }

if [ -f "$ENV_FILE" ]; then
  say "$ENV_FILE уже есть — не трогаю."
  say "Если нужно завести заново: сохраните ENCRYPTION_KEY, иначе зашифрованные поля пропадут."
else
  say "Завожу $ENV_FILE со случайными паролями…"
  cp .env.docker.example "$ENV_FILE"

  set_var() {
    # значение подставляется через awk, а не sed: в base64 попадаются / и &,
    # которые sed трактует как части замены и молча портит пароль
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' \
      "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  }

  set_var POSTGRES_PASSWORD "$(rnd 24)"
  set_var APP_DB_PASSWORD   "$(rnd 24)"
  set_var JWT_SECRET        "$(rnd 32)"
  set_var ENCRYPTION_KEY    "v1:$(head -c 32 /dev/urandom | base64)"

  if [ -n "$DOMAIN" ]; then
    set_var SITE_ADDRESS "$DOMAIN"
    set_var CORS_ORIGINS "https://$DOMAIN"
    set_var CONSOLE_URL  "https://$DOMAIN"
  fi

  chmod 600 "$ENV_FILE"
fi

# ── 3. Запуск ────────────────────────────────────────────────────────────────
say "Собираю образы. Первый раз это долго: собирается whisper.cpp."
docker compose --env-file "$ENV_FILE" up -d --build

# Ждём не «контейнер поднялся», а «приложение отвечает»: поднявшийся
# контейнер с упавшим внутри процессом выглядит удачной установкой.
# И не `up --wait`: он спотыкается о разовый контейнер подготовки, который
# штатно завершается, — и объявляет отказом нормальную работу.
say "Жду, пока приложение ответит…"
ready=""
for _ in $(seq 1 60); do
  if docker compose --env-file "$ENV_FILE" exec -T api \
       bun -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
       >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 5
done
[ -n "$ready" ] || die "Приложение не ответило за пять минут.
Смотрите: docker compose --env-file $ENV_FILE logs api"

# Спрашиваем само приложение, а не его журнал: строка в журнале одна на весь
# запуск, она ротируется и может ещё не дойти до вывода в момент проверки —
# так эта проверка один раз и соврала.
say "Проверяю, что политики строк действуют…"
if docker compose --env-file "$ENV_FILE" exec -T api \
     bun -e "fetch('http://localhost:3001/health/ready').then(r=>r.json()).then(j=>process.exit(j.rls?0:1)).catch(()=>process.exit(1))" \
     >/dev/null 2>&1; then
  echo "  ✓ RLS активна"
else
  die "RLS не активна — приложение подключается ролью с правами владельца.
Все политики остаются на месте, но каждый видит всё.
Смотрите: docker compose --env-file $ENV_FILE logs api"
fi

say "Проверяю шифрование полей…"
if docker compose --env-file "$ENV_FILE" logs api | grep -q "crypto.disabled"; then
  die "ENCRYPTION_KEY не задан: ФИО, заключения и свободные ответы пишутся открыто."
else
  echo "  ✓ шифрование включено"
fi

# Первый администратор заводится через контейнер подготовки, а не через api.
# У api роль без прав владельца — это и есть смысл всей затеи с двумя ролями,
# и установщику её не хватает.
say "Завожу первого администратора…"
docker compose --env-file "$ENV_FILE" run --rm provision bun apps/api/src/install.ts
echo
if [ -n "$DOMAIN" ]; then
  echo "Консоль: https://$DOMAIN"
  echo "Сертификат Caddy выдаст сам при первом обращении — A-запись домена"
  echo "должна уже указывать на этот сервер."
else
  echo "Консоль: http://$(curl -s ifconfig.me || echo '<ip сервера>')"
  echo "Домен вписывается в SITE_ADDRESS в $ENV_FILE, затем:"
  echo "  docker compose --env-file $ENV_FILE up -d web"
fi
echo
echo "Сохраните ENCRYPTION_KEY из $ENV_FILE отдельно от сервера."
echo "Без него зашифрованные поля не прочитать ничем — восстановлению не подлежат."
