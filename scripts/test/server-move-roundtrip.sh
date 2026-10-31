#!/usr/bin/env bash
# Сквозная проверка переезда (scripts/server-move.sh) на двух контейнерах:
#   настоящие ssh, tar, PostgreSQL 16, backup.sh, restore.sh и gpg; заглушены
#   только docker compose, systemctl и установщик — их вызовы пишутся в журнал
#   вместе с окружением запуска.
#
#   ./scripts/test/server-move-roundtrip.sh
#
# Что проверяется: отказы без отметки цели и при перепутанных OLD и NEW;
# окружение доезжает байт в байт; проба молчит, а старый работает; cutover
# останавливает старый до снимка, сверяет данные и запускает новый в полную
# работу; повторный cutover базу не трогает; сбой подсказывает откат; секреты.
#
# Нужен docker. В CI не входит: образ собирается минуты, а сценарий меняется
# редко — гонять после правок server-move.sh, restore.sh и backup.sh.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="/tmp/quizzy-move-test.$$"
mkdir -m 700 "$tmp"
image="quizzy-move-test"
old="quizzy-move-old-$$"
new="quizzy-move-new-$$"
trap 'docker rm -f "$old" "$new" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=1; }
check() { # описание, код — успех
  if eval "$2"; then ok "$1"; else bad "$1 [$2]"; fi
}

mkdir -p "$tmp/img"
cat > "$tmp/img/Dockerfile" <<'DOCKER'
FROM postgres:16-bookworm
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends openssh-server zstd gnupg procps >/dev/null \
 && mkdir -p /run/sshd && ssh-keygen -A \
 && mkdir -p /var/backups/quizzy
COPY docker systemctl git uname /usr/local/bin/
RUN chmod +x /usr/local/bin/docker /usr/local/bin/systemctl /usr/local/bin/git /usr/local/bin/uname
DOCKER

# compose: exec в postgres — настоящие утилиты, остальное — запись в журнал.
# В журнале — окружение запуска: по нему видно, тихий ли подъём.
cat > "$tmp/img/docker" <<'STUB'
#!/bin/bash
export PATH=/usr/lib/postgresql/16/bin:$PATH
echo "SCHED=${SCHEDULER_ENABLED-unset} SMTP=${SMTP_URL-unset} docker $*" >> /var/log/stub.log
if [ "$1" = volume ]; then
  d="/var/lib/docker/volumes/${*: -1}/_data"
  mkdir -p "$d"; echo "$d"; exit 0
fi
[ "$1" = compose ] || exit 0
shift 3
verb="$1"; shift
case "$verb" in
  exec)
    [ "$1" = -T ] && shift
    svc="$1"; shift
    if [ "$svc" = postgres ]; then exec "$@"; fi
    if [ "$1" = printenv ]; then cat /var/run/stub-sched; fi
    ;;
  up) echo "${SCHEDULER_ENABLED:-1}" > /var/run/stub-sched ;;
esac
STUB

cat > "$tmp/img/systemctl" <<'STUB'
#!/bin/bash
echo "systemctl $*" >> /var/log/stub.log
case "$1 $2" in
  "show quizzy-backup.service")
    [ -f /etc/stub-unit ] || exit 0
    case "$*" in
      *WorkingDirectory*)  cat /etc/stub-unit ;;
      *EnvironmentFiles*)  echo '/root/quizzy-backup.env (ignore_errors=no)' ;;
      *)                   echo '"PG_EXEC=docker compose --env-file .env.docker exec -T postgres"' ;;
    esac ;;
  "cat quizzy-backup.service") [ -f /etc/stub-unit ] ;;
  "start quizzy-backup.service")
    cd "$(cat /etc/stub-unit)"
    set -a; . /root/quizzy-backup.env; set +a
    PG_EXEC="docker compose --env-file .env.docker exec -T postgres" bash scripts/backup.sh ;;
esac
STUB

# Клон — копия настоящих скриптов; установщик подменён, его итог изображён
cat > "$tmp/img/git" <<'STUB'
#!/bin/bash
[ "$1" = clone ] || exit 0
mkdir -p /opt/quizzy/.git
cp -r /srv/repo/scripts /opt/quizzy/scripts
cat > /opt/quizzy/scripts/server-install.sh <<'INSTALL'
#!/bin/bash
echo "server-install $1 SCHED=${SCHEDULER_ENABLED-unset} SMTP=${SMTP_URL-unset}" >> /var/log/stub.log
[ -s /opt/quizzy/.env.docker ] && grep -q '^BACKUP_PASSPHRASE=.' /root/quizzy-backup.env || exit 1
echo /opt/quizzy > /etc/stub-unit
echo "${SCHEDULER_ENABLED:-1}" > /var/run/stub-sched
/usr/lib/postgresql/16/bin/psql -q -U quizzy -d quizzy -c "create role quizzy_app login password 'x'" -c 'create table residue(id int)'
mkdir -p /root/.ssh && echo FAKE-ACTIONS-KEY > /root/.ssh/quizzy_actions
INSTALL
STUB

# образы только под amd64, а контейнер на чужой машине может быть arm64
cat > "$tmp/img/uname" <<'STUB'
#!/bin/bash
if [ "$1" = -m ]; then echo x86_64; else /bin/uname "$@"; fi
STUB

echo "Стенд"
docker build -q -t "$image" "$tmp/img" >/dev/null
for c in "$old" "$new"; do
  docker run -d --name "$c" -e POSTGRES_USER=quizzy -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=quizzy \
    -p 127.0.0.1::22 "$image" >/dev/null
  for _ in $(seq 1 60); do docker exec "$c" pg_isready -q -U quizzy && break; sleep 1; done
done
ssh-keygen -q -t ed25519 -N "" -f "$tmp/key"
for c in "$old" "$new"; do
  docker exec "$c" sh -c 'mkdir -p /root/.ssh /srv/repo && chmod 700 /root/.ssh && touch /var/log/stub.log'
  docker cp "$tmp/key.pub" "$c:/root/.ssh/authorized_keys" >/dev/null
  docker exec "$c" sh -c "chown root:root /root/.ssh/authorized_keys; head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > /etc/machine-id"
  docker exec -d "$c" /usr/sbin/sshd -D
done
{
  for pair in "old-box $old" "new-box $new"; do
    set -- $pair
    printf 'Host %s\n  HostName 127.0.0.1\n  Port %s\n  User root\n  IdentityFile %s/key\n  IdentitiesOnly yes\n  StrictHostKeyChecking no\n  UserKnownHostsFile /dev/null\n  LogLevel ERROR\n' \
      "$1" "$(docker port "$2" 22/tcp | cut -d: -f2)" "$tmp"
  done
} > "$tmp/ssh_config"
export SSH_OPTS="-F $tmp/ssh_config" OLD=root@old-box NEW=root@new-box VPS_HOST=203.0.113.7

# Старый сервер: каталог не /opt/quizzy, окружение с пробелами и «<», которое
# нельзя разбирать оболочкой, и данные во всех переносимых местах
docker cp "$repo/scripts" "$old:/srv/repo/scripts" >/dev/null
docker cp "$repo/scripts" "$new:/srv/repo/scripts" >/dev/null
docker exec -i "$old" bash -s <<'SEED'
set -e
mkdir -p /srv/quizzy-old /var/lib/docker/volumes/quizzy_recordings/_data/2026 \
  /var/lib/docker/volumes/quizzy_caddy_data/_data/certificates /var/lib/docker/volumes/quizzy_pgdata/_data \
  /var/backups/quizzy/monthly
cp -r /srv/repo/scripts /srv/quizzy-old/scripts
echo /srv/quizzy-old > /etc/stub-unit
cat > /srv/quizzy-old/.env.docker <<'ENV'
POSTGRES_PASSWORD=pw
ENCRYPTION_KEY=v1:ключ-старого-сервера
OPEN_REGISTRATION=0
MAIL_FROM=Quizzy <noreply@polypsy.test>
SMTP_URL=smtp://u:p%2Fss@127.0.0.1:22
SITE_ADDRESS=polypsy.test
QUIZZY_IMAGE_PREFIX=ghcr.io/4booser/polypsy
QUIZZY_VERSION=v2.2.0
ENV
chmod 600 /srv/quizzy-old/.env.docker
cat > /root/quizzy-backup.env <<'ENV'
BACKUP_PASSPHRASE='старая фраза с пробелами'
BACKUP_DIR=/var/backups/quizzy
DATABASE_URL=postgres://quizzy:pw@127.0.0.1:5432/quizzy
ENV
head -c 3000 /dev/urandom > /var/lib/docker/volumes/quizzy_recordings/_data/2026/a.enc
chown -R 1000:1000 /var/lib/docker/volumes/quizzy_recordings/_data
chmod 700 /var/lib/docker/volumes/quizzy_recordings/_data
echo cert > /var/lib/docker/volumes/quizzy_caddy_data/_data/certificates/polypsy.test.crt
echo история > /var/backups/quizzy/monthly/quizzy_2026-10-01_030008.dump.zst.gpg
psql -q -U quizzy -d quizzy <<'SQL'
create role quizzy_app login password 'old';
create schema drizzle;
create table drizzle."__drizzle_migrations"(id serial primary key, hash text);
insert into drizzle."__drizzle_migrations"(hash) values ('a'), ('b');
create table users(id serial primary key, name text);
create table responses(id serial primary key);
create table audit_log(seq bigint, entry_hash text);
grant select on users to quizzy_app;
insert into users(name) values ('перший'), ('другий');
insert into responses default values;
insert into audit_log values (1, 'h1'), (2, 'h2');
SQL
SEED
ok "старый и новый подняты"

move() { "$repo/scripts/server-move.sh" "$@"; }
in_old() { docker exec "$old" bash -c "$1"; }
in_new() { docker exec "$new" bash -c "$1"; }
users_on() { docker exec "$1" psql -U quizzy -d quizzy -tAc 'select count(*) from users'; }

echo "1. Защита"
OLD=root@new-box NEW=root@new-box move check >/dev/null 2>&1 && bad "OLD = NEW принят" || ok "OLD = NEW — отказ"
move rehearse > "$tmp/out" 2>&1 && bad "проба без install прошла" || ok "проба без отметки цели — отказ"
check "старая база не тронута" '[ "$(users_on "$old")" = 2 ]'

echo "2. check на голом новом сервере"
if move check > "$tmp/out" 2>&1; then ok "препятствий нет"; else bad "check: $(tail -n 12 "$tmp/out")"; fi
check "пароль SMTP не напечатан" '! grep -q "p%2Fss" "$tmp/out"'
check "названа версия старого" 'grep -q v2.2.0 "$tmp/out"'
check "сказано об отсутствии внешней копии" 'grep -q "внешней копии нет" "$tmp/out"'

echo "3. install"
if move install > "$tmp/out" 2>&1; then ok "прошёл"; else bad "install: $(tail -n 12 "$tmp/out")"; fi
check "окружение совпало байт в байт" '[ "$(in_old "sha256sum < /srv/quizzy-old/.env.docker")" = "$(in_new "sha256sum < /opt/quizzy/.env.docker")" ]'
check "окружение только владельцу" '[ "$(in_new "stat -c %a /opt/quizzy/.env.docker")" = 600 ]'
check "фраза копий старая, файл только владельцу" '[ "$(in_new ". /root/quizzy-backup.env; echo \"\$BACKUP_PASSPHRASE\"")" = "старая фраза с пробелами" ] && [ "$(in_new "stat -c %a /root/quizzy-backup.env")" = 600 ]'
check "установщик запущен тихо" 'in_new "grep -q \"server-install polypsy.test SCHED=0 SMTP= *\$\" /var/log/stub.log"'
check "отметка цели стоит" 'in_new "[ -f /root/.quizzy-move-target ]"'

echo "4. rehearse"
if move rehearse > "$tmp/out" 2>&1; then ok "прошёл"; else bad "rehearse: $(tail -n 12 "$tmp/out")"; fi
check "данные доехали" '[ "$(users_on "$new")" = 2 ]'
check "база новая: остатков прежней нет" '[ "$(docker exec "$new" psql -U quizzy -d quizzy -tAc "select count(*) from pg_tables where tablename = '"'"'residue'"'"'")" = 0 ]'
check "права роли приложения на месте" '[ "$(docker exec "$new" psql -U quizzy -d quizzy -tAc "select has_table_privilege('"'"'quizzy_app'"'"', '"'"'users'"'"', '"'"'select'"'"')")" = t ]'
check "запись приёма: тот же файл и владелец" '[ "$(in_old "cd /var/lib/docker/volumes/quizzy_recordings/_data && stat -c %u:%a . 2026/a.enc && sha256sum 2026/a.enc")" = "$(in_new "cd /var/lib/docker/volumes/quizzy_recordings/_data && stat -c %u:%a . 2026/a.enc && sha256sum 2026/a.enc")" ]'
check "сертификаты доехали" 'in_new "[ -s /var/lib/docker/volumes/quizzy_caddy_data/_data/certificates/polypsy.test.crt ]"'
check "история копий доехала" 'in_new "[ -s /var/backups/quizzy/monthly/quizzy_2026-10-01_030008.dump.zst.gpg ]"'
check "подъём тихий" 'in_new "grep \"up -d\" /var/log/stub.log | tail -n 1 | grep -q \"^SCHED=0 SMTP= \""'
check "планировщик выключен" '[ "$(in_new "cat /var/run/stub-sched")" = 0 ]'
check "старый не останавливался" '! in_old "grep -q \" stop \" /var/log/stub.log"'
check "снимок не в ротации" 'in_old "ls /var/backups/quizzy/premove/*.gpg >/dev/null && [ ! -d /var/backups/quizzy/daily ]"'

echo "5. cutover"
in_old "psql -q -U quizzy -d quizzy -c \"insert into users(name) values ('третій')\" -c \"insert into audit_log values (3, 'h3')\"; echo новая > /var/lib/docker/volumes/quizzy_recordings/_data/2026/b.enc"
MOVE_CONFIRM=другой.домен move cutover > "$tmp/out" 2>&1 && bad "принят чужой домен" || ok "неверный домен — отказ"
check "после отказа старый работает" '! in_old "grep -q \" stop \" /var/log/stub.log"'
if MOVE_CONFIRM=polypsy.test move cutover > "$tmp/out" 2>&1; then ok "прошёл"; else bad "cutover: $(tail -n 12 "$tmp/out")"; fi
check "последняя запись доехала" '[ "$(users_on "$new")" = 3 ]'
check "последний файл доехал" 'in_new "[ -s /var/lib/docker/volumes/quizzy_recordings/_data/2026/b.enc ]"'
check "старый остановлен до снимка" 'in_old "n=\$(grep -n \"stop api transcriber\" /var/log/stub.log | tail -n 1 | cut -d: -f1); d=\$(grep -n \"exec -T postgres pg_dump\" /var/log/stub.log | tail -n 1 | cut -d: -f1); [ \"\$n\" -lt \"\$d\" ]"'
check "новый в полной работе" 'in_new "grep \"up -d\" /var/log/stub.log | tail -n 1 | grep -q \"^SCHED=unset SMTP=unset \"" && [ "$(in_new "cat /var/run/stub-sched")" = 1 ]'
check "таймеры старого выключены" 'in_old "grep -q \"disable --now quizzy-backup.timer\" /var/log/stub.log"'
check "на новом снята настоящая копия" 'in_new "ls /var/backups/quizzy/*/quizzy_*.gpg | grep -v premove | grep -qv 2026-10-01"'
check "отметка снята" '! in_new "[ -f /root/.quizzy-move-target ]"'

echo "6. После переезда"
in_new "psql -q -U quizzy -d quizzy -c \"insert into users(name) values ('запис на новому')\""
MOVE_CONFIRM=polypsy.test move cutover > "$tmp/out" 2>&1 && bad "повторный cutover прошёл" || ok "повторный cutover — отказ"
MOVE_CONFIRM=polypsy.test move rehearse > "$tmp/out" 2>&1 && bad "повторная проба прошла" || ok "повторная проба — отказ"
check "база нового не тронута" '[ "$(users_on "$new")" = 4 ]'
OLD=root@new-box NEW=root@old-box move rehearse > "$tmp/out" 2>&1 && bad "перепутанные OLD и NEW прошли" || ok "перепутанные OLD и NEW — отказ"
OLD=root@new-box NEW=root@old-box move install > "$tmp/out" 2>&1 && bad "install на рабочий сервер прошёл" || ok "install на рабочий сервер — отказ"
check "на рабочем сервере отметки не появилось" '! in_old "[ -f /root/.quizzy-move-target ]"'
check "старая база цела" '[ "$(users_on "$old")" = 3 ]'

echo "7. secrets"
mkdir "$tmp/bin"
cat > "$tmp/bin/gh" <<STUB
#!/bin/bash
{ echo "== \$3"; cat; echo; } >> "$tmp/gh.log"
STUB
chmod +x "$tmp/bin/gh"
if PATH="$tmp/bin:$PATH" move secrets > "$tmp/out" 2>&1; then ok "прошёл"; else bad "secrets: $(tail -n 8 "$tmp/out")"; fi
check "ключ раннера — с нового сервера" 'grep -q FAKE-ACTIONS-KEY "$tmp/gh.log"'
check "адрес и каталог" 'grep -q 203.0.113.7 "$tmp/gh.log" && grep -q /opt/quizzy "$tmp/gh.log"'

echo "8. Откат и сбой"
if move rollback > "$tmp/out" 2>&1; then ok "rollback прошёл"; else bad "rollback: $(tail -n 8 "$tmp/out")"; fi
check "новый остановлен" 'in_new "grep \"stop api transcriber\" /var/log/stub.log | tail -n 1 | grep -q stop"'
check "старый поднят, таймер включён" 'in_old "grep -q \"up -d\" /var/log/stub.log && grep -q \"enable --now quizzy-backup.timer\" /var/log/stub.log"'
# сбой посреди простоя: фраза на новом не открывает снимок
in_new "sed -i \"s/^BACKUP_PASSPHRASE=.*/BACKUP_PASSPHRASE='чужая'/\" /root/quizzy-backup.env"
MOVE_CONFIRM=polypsy.test move cutover > "$tmp/out" 2>&1 && bad "cutover с неверной фразой прошёл" || ok "сбой останавливает cutover"
check "подсказан откат" 'grep -q "rollback" "$tmp/out"'
check "приложение на новом не запущено на обломках" '! grep -q "Запуск в полную работу" "$tmp/out"'
check "старая база цела" '[ "$(users_on "$old")" = 3 ]'

[ "$fail" = 0 ] && echo "переезд: все проверки прошли" || { echo "ПРОВАЛ"; exit 1; }
