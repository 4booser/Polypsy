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

# ── 1а. Защита хоста ──────────────────────────────────────────────────────────
# Только на Debian/Ubuntu: там есть unattended-upgrades, ufw и fail2ban
# штатными пакетами. На прежнем сервере (Arch) порт 22 был забит перебором
# паролей настолько, что sshd сбрасывал и выкатку (MaxStartups), а
# обновлений безопасности не было вовсе. Ничего из этого не делается, если
# у входящего нет ключа: иначе отключение паролей запирает дверь снаружи.
if command -v apt-get >/dev/null 2>&1; then
  say "Защита хоста…"
  export DEBIAN_FRONTEND=noninteractive
  # python3-systemd — чтение журнала systemd для fail2ban (backend ниже)
  apt-get install -y -q unattended-upgrades ufw fail2ban python3-systemd >/dev/null
  # обновления безопасности — сами, без перезагрузки посреди дня
  dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

  # Снаружи — только ssh и сайт; остальное (postgres, api) живёт в сети docker.
  #
  # Правила ДОБАВЛЯЮТСЯ, а не пишутся заново. Прежде здесь стоял
  # `ufw --force reset`: повторный запуск стирал правила администратора, и
  # ssh, ограниченный им до своих адресов, снова открывался всем (#164).
  # Теперь порт, у которого правило уже есть (любое — откуда угодно или с
  # одного адреса), не трогается; политики по умолчанию ставятся только при
  # первом включении. Порт ssh — тот, что слушает sshd, а не всегда 22:
  # иначе включение ufw запирает дверь на сервере с перенесённым ssh.
  #
  # Вывод ufw читается целиком в переменную, а не конвейером в grep -q: под
  # pipefail ранний выход grep обрывает пишущего, и проверка врёт.
  ufw_state="$(ufw status 2>/dev/null || true)"
  if [[ "$ufw_state" != *"Status: active"* ]]; then
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
  fi
  ufw_added="$(ufw show added 2>/dev/null || true)"
  ssh_ports="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' || true)"
  for port in ${ssh_ports:-22} 80 443; do
    if grep -Eq "(^|[[:space:]])$port(/tcp)?([[:space:]]|\$)" <<<"$ufw_added" \
       || { [ "$port" = 22 ] && grep -Eq '(^|[[:space:]])OpenSSH([[:space:]]|$)' <<<"$ufw_added"; }; then
      echo "  · ufw: у порта $port правило уже есть — не трогаю"
    else
      ufw allow "$port/tcp" >/dev/null
    fi
  done
  ufw --force enable >/dev/null

  # Перебор паролей — в бан после пяти промахов на час.
  #
  # backend = systemd: в Debian 12 нет /var/log/auth.log, sshd пишет только
  # в журнал systemd, и джейл с журналом-файлом его не находит — fail2ban не
  # стартует вовсе. Прежде отказ прятался за `|| true`, а установка
  # печатала «✓ … fail2ban». Теперь служба перезапускается (у работающей
  # иначе не подхватится новый джейл), джейл sshd спрашивается у самого
  # fail2ban, и отказ останавливает установку с журналом службы.
  cat > /etc/fail2ban/jail.d/quizzy.conf <<'JAIL'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
JAIL
  systemctl enable --quiet fail2ban
  f2b_ok=""
  if systemctl restart fail2ban; then
    for _ in $(seq 1 15); do
      fail2ban-client status sshd >/dev/null 2>&1 && { f2b_ok=1; break; }
      sleep 1
    done
  fi
  if [ -z "$f2b_ok" ]; then
    journalctl -u fail2ban -n 20 --no-pager -o cat >&2 2>/dev/null || true
    die "fail2ban не поднял джейл sshd — защиты от перебора паролей нет.
Журнал службы выше; разобранная настройка: fail2ban-client -d"
  fi
  echo "  ✓ fail2ban: джейл sshd работает"
  # пароли по ssh — только если есть чем войти без них
  keyfile="${SUDO_USER:+/home/$SUDO_USER/.ssh/authorized_keys}"
  if [ -s /root/.ssh/authorized_keys ] || { [ -n "$keyfile" ] && [ -s "$keyfile" ]; }; then
    install -d -m 755 /etc/ssh/sshd_config.d
    cat > /etc/ssh/sshd_config.d/10-quizzy.conf <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 4
# очередь неаутентифицированных: выкатка открывает одно соединение, а боты —
# десятки; дефолт 10:30:100 сбрасывал и её
MaxStartups 30:50:200
SSHD
    sshd -t && systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
    echo "  ✓ ssh: только ключи, root без пароля, ufw (ssh/80/443), обновления безопасности"
  else
    echo "  ! ssh-ключа нет ни у root, ни у ${SUDO_USER:-вас} — пароли по ssh оставлены. Добавьте ключ и запустите скрипт ещё раз."
  fi
fi

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
  # Слепой индекс телефона и коды выгрузок — свои секреты, не JWT_SECRET:
  # иначе утечка секрета подписи раскрывает телефоны перебором, а его
  # ротация молча ломает дедупликацию номеров и склейку лонгитюда.
  set_var PHONE_INDEX_SECRET "$(rnd 32)"
  set_var EXPORT_SECRET      "$(rnd 32)"
  # слепой индекс поиска по записям приёма — тоже свой (волна 18, #25)
  set_var SEARCH_INDEX_SECRET "$(rnd 32)"

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

# Спрашиваем файл окружения, а не журнал приложения: без ключа приложение
# теперь просто не стартует (см. env.ts), и грепать его журнал на строку
# «шифрование выключено» больше нечего — такой строки не бывает. Проверка
# осталась ради того, чтобы установка не прошла с пустой переменной и
# «успешным» выводом.
say "Проверяю шифрование полей…"
if grep -q '^ENCRYPTION_KEY=v' "$ENV_FILE"; then
  echo "  ✓ шифрование включено"
else
  die "ENCRYPTION_KEY не задан: без него приложение не поднимется, а карты пациентов легли бы открытыми."
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
