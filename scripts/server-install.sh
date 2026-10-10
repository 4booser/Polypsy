#!/usr/bin/env bash
# Полная установка на чистый Debian одной командой.
#
#   scp scripts/server-install.sh root@<сервер>:/root/
#   ssh root@<сервер> 'bash /root/server-install.sh polypsy.ink'
#
# Делает всё, что иначе разложено по docs/DEPLOY.md на пятнадцать шагов:
#   1. пакеты; 2. ключ чтения хранилища (deploy key) и клон в /opt/quizzy;
#   3. vps-setup.sh — Docker, защита хоста, окружение, стек, первый админ;
#   4. копии базы: окружение службы, таймеры снимка и проверки;
#   5. ключ для выкатки из GitHub Actions и значения секретов на печать;
#   6. что сохранить вне сервера и что сделать руками (DNS, секреты).
#
# Идемпотентен: повторный запуск доделывает то, чего нет, и не трогает
# ключи, пароли и фразы, которые уже есть. Переезд со старого сервера —
# тот же скрипт, затем перенос секретов и восстановление копии по
# docs/DEPLOY.md, «Переезд на другой сервер».
set -euo pipefail

DOMAIN="${1:-}"
REPO="${REPO:-git@github.com:4booser/Quizzy.git}"
TARGET="${TARGET:-/opt/quizzy}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/quizzy}"
BACKUP_ENV=/root/quizzy-backup.env

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }
rnd() { head -c "$1" /dev/urandom | base64 | tr '+/' '-_' | tr -d '\n='; }

[ "$(id -u)" = 0 ] || die "Запускать от root: sudo bash $0 $*"
command -v apt-get >/dev/null 2>&1 || die "Скрипт для Debian/Ubuntu (apt)."
[ -n "$DOMAIN" ] || { read -r -p "Домен сайта (например polypsy.ink): " DOMAIN; [ -n "$DOMAIN" ] || die "без домена сертификата не будет"; }

# ── 1. Пакеты ────────────────────────────────────────────────────────────────
say "1/6 Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q >/dev/null
# gnupg и zstd нужны backup.sh на хосте (pg_dump идёт в контейнере)
apt-get install -y -q git curl ca-certificates gnupg zstd openssh-client >/dev/null
echo "  ✓ git, curl, gnupg, zstd"

# ── 2. Хранилище ─────────────────────────────────────────────────────────────
# Репозиторий приватный: серверу нужен свой ключ только на чтение. Закрытая
# часть рождается здесь и никуда не уезжает.
say "2/6 Ключ чтения хранилища"
install -d -m 700 /root/.ssh
if [ ! -f /root/.ssh/quizzy_deploy ]; then
  ssh-keygen -q -t ed25519 -f /root/.ssh/quizzy_deploy -N "" -C "quizzy-deploy@$(hostname)"
fi
grep -q 'IdentityFile ~/.ssh/quizzy_deploy' /root/.ssh/config 2>/dev/null || cat >> /root/.ssh/config <<'CFG'
Host github.com
  IdentityFile ~/.ssh/quizzy_deploy
  IdentitiesOnly yes
CFG
chmod 600 /root/.ssh/config
ssh-keyscan -t ed25519 github.com 2>/dev/null >> /root/.ssh/known_hosts
sort -u -o /root/.ssh/known_hosts /root/.ssh/known_hosts

# Доступ — по тексту приветствия, а не по коду выхода и не конвейером.
# ssh -T git@github.com выходит с 1 и при принятом ключе («…successfully
# authenticated, but GitHub does not provide shell access»), так что под
# pipefail `ssh … | grep -q` был ложью всегда: установка на чистом сервере
# вечно ждала ключ, который давно добавлен (#164).
github_ok() {
  local out
  out="$(ssh -o BatchMode=yes -o ConnectTimeout=15 -T git@github.com 2>&1)" || true
  [[ "$out" == *"successfully authenticated"* ]]
}
until github_ok; do
  echo
  echo "  Добавьте этот ключ в GitHub: репозиторий → Settings → Deploy keys → Add,"
  echo "  БЕЗ права записи:"
  echo
  cat /root/.ssh/quizzy_deploy.pub
  echo
  read -r -p "  Добавили? Enter — проверю ещё раз, Ctrl+C — выйти. "
done
echo "  ✓ GitHub принимает ключ"

if [ -d "$TARGET/.git" ]; then
  # рабочая копия уже есть: подтягиваем, но не падаем — правки на сервере
  # или отсутствие сети не повод бросать установку на середине
  if git -C "$TARGET" pull -q --ff-only 2>/dev/null; then
    echo "  ✓ $TARGET обновлён"
  else
    echo "  ! $TARGET не обновился (локальные правки или нет связи) — продолжаю с тем, что есть"
  fi
else
  git clone -q "$REPO" "$TARGET"
  echo "  ✓ склонировано в $TARGET"
fi
cd "$TARGET"
echo "  версия в рабочей копии: $(git describe --tags --always)"

# ── 3. Docker, защита хоста, окружение, стек ─────────────────────────────────
say "3/6 Установка экземпляра (vps-setup.sh)"
./scripts/vps-setup.sh "$DOMAIN"

# ── 4. Копии базы ────────────────────────────────────────────────────────────
# Служба systemd, а не cron: у неё есть окружение (EnvironmentFile),
# журнал и статус, и обслуживание (maintenance.yml) читает их оттуда же.
say "4/6 Копии базы"
install -d -m 700 "$BACKUP_DIR"
pg_pw="$(grep '^POSTGRES_PASSWORD=' .env.docker | cut -d= -f2-)"
[ -n "$pg_pw" ] || die "в .env.docker нет POSTGRES_PASSWORD"
if [ -f "$BACKUP_ENV" ]; then
  echo "  $BACKUP_ENV уже есть — фразу не трогаю"
else
  umask 077
  cat > "$BACKUP_ENV" <<ENV
# Окружение службы копий. Фразу сохраните ВНЕ сервера: без неё копии не
# прочитать. Внешняя копия (другой поставщик) — см. docs/DEPLOY.md:
# OFFSITE_URL=…  OFFSITE_KEY_ID=…  OFFSITE_SECRET=…  OFFSITE_REGION=auto
BACKUP_PASSPHRASE=$(rnd 32)
BACKUP_DIR=$BACKUP_DIR
DATABASE_URL=postgres://quizzy:$pg_pw@127.0.0.1:5432/quizzy
ENV
  umask 022
  echo "  ✓ $BACKUP_ENV с новой парольной фразой"
fi
# compose exec — чтобы pg_dump и pg_restore были той же версии, что сервер
cat > /etc/systemd/system/quizzy-backup.service <<UNIT
[Unit]
Description=Quizzy: снимок базы
After=docker.service
[Service]
Type=oneshot
WorkingDirectory=$TARGET
EnvironmentFile=$BACKUP_ENV
Environment="PG_EXEC=docker compose --env-file .env.docker exec -T postgres"
ExecStart=$TARGET/scripts/backup.sh
UNIT
cat > /etc/systemd/system/quizzy-backup.timer <<'UNIT'
[Unit]
Description=Quizzy: снимок базы каждую ночь
[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/quizzy-verify.service <<UNIT
[Unit]
Description=Quizzy: проверка восстановимости копии
After=docker.service
[Service]
Type=oneshot
WorkingDirectory=$TARGET
EnvironmentFile=$BACKUP_ENV
Environment="PG_EXEC=docker compose --env-file .env.docker exec -T postgres"
ExecStart=$TARGET/scripts/verify-backup.sh
UNIT
cat > /etc/systemd/system/quizzy-verify.timer <<'UNIT'
[Unit]
Description=Quizzy: проверка восстановимости по понедельникам
[Timer]
OnCalendar=Mon *-*-* 04:00:00
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now quizzy-backup.timer quizzy-verify.timer >/dev/null 2>&1
echo "  ✓ таймеры: снимок 03:00 ежедневно, проверка Пн 04:00"
if systemctl start quizzy-backup.service; then
  # самый свежий файл копии, а не первая строка ls по подкаталогам — та
  # печатала заголовок «…/daily/:», а не снимок
  newest="$(find "$BACKUP_DIR" -type f -name 'quizzy_*.dump.zst.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2- || true)"
  echo "  ✓ первый снимок: ${newest:-файла не видно — journalctl -u quizzy-backup.service}"
else
  echo "  ! первый снимок не удался: journalctl -u quizzy-backup.service"
fi

# ── 5. Выкатка из GitHub Actions ─────────────────────────────────────────────
# Отдельная пара ключей для раннера: закрытую часть кладут в секрет
# VPS_SSH_KEY, открытая — в authorized_keys. Печатается один раз, здесь, в
# вашем терминале; на диске остаётся в /root/.ssh/quizzy_actions.
say "5/6 Доступ выкатки из GitHub Actions"
if [ ! -f /root/.ssh/quizzy_actions ]; then
  ssh-keygen -q -t ed25519 -f /root/.ssh/quizzy_actions -N "" -C "quizzy-actions"
fi
grep -qF "$(cut -d' ' -f2 /root/.ssh/quizzy_actions.pub)" /root/.ssh/authorized_keys 2>/dev/null \
  || cat /root/.ssh/quizzy_actions.pub >> /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
host_ip="$(curl -s --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')"
echo "  ✓ ключ раннера добавлен в authorized_keys"

# ── 6. Итог ──────────────────────────────────────────────────────────────────
say "6/6 Что сделать руками"
cat <<EOF

A. Секреты репозитория (Settings → Secrets and variables → Actions):
   VPS_HOST          $host_ip
   VPS_USER          root
   VPS_PATH          $TARGET
   SITE_ADDRESS      $DOMAIN
   ACME_EMAIL        <почта для Let's Encrypt>
   VPS_KNOWN_HOSTS   (одна строка):
$(ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null | sed "s/^127.0.0.1/$host_ip/; s/^/     /")
   VPS_SSH_KEY       (целиком, включая BEGIN/END):
$(sed 's/^/     /' /root/.ssh/quizzy_actions)

B. DNS: A-запись $DOMAIN → $host_ip. Сертификат Caddy выдаст сам.

C. Сохраните ВНЕ сервера (менеджер паролей) — без них данные не вернуть:
   ENCRYPTION_KEY    из $TARGET/.env.docker
   BACKUP_PASSPHRASE из $BACKUP_ENV

D. Внешняя копия у другого поставщика: впишите OFFSITE_* в $BACKUP_ENV
   (docs/DEPLOY.md, «Внешняя копия») и проверьте действием offsite-status.

E. Переезд с прежнего сервера: docs/DEPLOY.md, «Переезд на другой сервер»
   (перенос ENCRYPTION_KEY и прочих секретов, записей приёмов, восстановление копии).

Проверка: https://$DOMAIN/health/ready после DNS; обслуживание backup-status, rls-check.
EOF
