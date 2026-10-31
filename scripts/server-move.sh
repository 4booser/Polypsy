#!/usr/bin/env bash
# Переезд экземпляра на другой сервер. Запускается с машины администратора,
# у которой есть ssh на оба сервера; на самих серверах ключей друг к другу нет.
#
#   export OLD=root@<старый> NEW=root@<новый>
#   scripts/server-move.sh check      что есть на обоих; ничего не меняет
#   scripts/server-move.sh install    поставить новый: то же окружение, те же образы
#   scripts/server-move.sh rehearse   проба: копия данных на новый, старый работает
#   scripts/server-move.sh cutover    заморозить старый, перенести, запустить новый
#   scripts/server-move.sh rollback   вернуть работу на старый (только до смены DNS)
#   scripts/server-move.sh secrets    секреты выкатки в GitHub — на новый (после DNS)
#
# Порядок целиком — docs/DEPLOY.md, «Переезд на другой сервер».
#
# Окружение едет целиком, вместе с паролями Postgres, и ДО первого запуска
# нового сервера. Прежний порядок переносил секреты выборочно поверх новых
# паролей: перечень отставал от .env.docker (OPEN_REGISTRATION, CONSOLE_URL,
# METRICS_TOKEN и другие оставались умолчаниями, регистрация и ссылки в
# письмах менялись молча), а перенесённый /root/quizzy-backup.env приносил
# адрес базы со старым паролем, и копии на новом сервере не снимались.
#
# Образы — той же версии, что на старом, из реестра, а не сборка из main:
# main обычно впереди выпуска, и миграции новее дампа увели бы схему вперёд
# выпуска, которым сервер потом выкатывается.
#
# База заливается в заново созданную, а не поверх рабочей: `restore.sh`
# поверх живой базы не проверяется ничем, а в чистую её каждый месяц
# разворачивает проверка восстановимости.
#
# Копия боевых данных молчит. Пробный экземпляр — это настоящие пациенты,
# настоящие токены пушей и настоящая почта: с планировщиком он слал бы те же
# напоминания и тревоги, что и работающий сервер, второй раз. Тишина задаётся
# окружением запуска (сильнее .env.docker), а сам файл остаётся боевым, так
# что любой обычный `up -d` возвращает полную работу и забыть её включить
# нельзя. Пуши с действий в консоли этим не выключить: на пробе только смотрят.
#
# Отметка MARK — единственное, что разрешает затирать базу: её ставит install,
# снимает завершённый cutover. Перепутанные OLD и NEW и повторный запуск после
# переезда останавливаются на ней, а не стирают боевые данные.
#
# Данные идут через эту машину по двум ssh: записи приёмов и копии базы и так
# зашифрованы, а ключи между серверами пришлось бы заводить и убирать.
set -euo pipefail

TARGET=/opt/quizzy
BACKUP_ENV=/root/quizzy-backup.env
MARK=/root/.quizzy-move-target
REPO="${REPO:-https://github.com/4booser/Polypsy.git}"
GH_REPO="${GH_REPO:-4booser/Polypsy}"
QUIET="SCHEDULER_ENABLED=0 SMTP_URL= TELEGRAM_BOT_TOKEN= TELEGRAM_CHAT_ID= GITHUB_DISPATCH_TOKEN= SENTRY_DSN="

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31m%s\033[0m\n\n' "$*" >&2; exit 1; }

cmd="${1:-}"
case "$cmd" in
  check|install|rehearse|cutover|rollback|secrets) ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
: "${OLD:?задайте OLD=root@<старый сервер>}"
: "${NEW:?задайте NEW=root@<новый сервер>}"
[ "$OLD" != "$NEW" ] || die "OLD и NEW — один и тот же адрес."

# Одно соединение на сервер: порт 22 старого забит перебором, и sshd
# сбрасывает новые подключения сверх MaxStartups (так падала выкатка v1.16.2),
# а без ключа пароль спрашивается один раз. Каталог короткий: адрес сокета
# ограничен сотней байт, а mktemp на macOS отдаёт длинный путь.
ctl="/tmp/quizzy-move.$$"
mkdir -m 700 "$ctl"
ssh_cmd=(ssh -o ControlMaster=auto -o "ControlPath=$ctl/%C" -o ControlPersist=120
  -o ServerAliveInterval=30 -o ConnectTimeout=20)
if [ -n "${SSH_OPTS:-}" ]; then
  read -r -a ssh_extra <<<"$SSH_OPTS"
  ssh_cmd+=("${ssh_extra[@]}")
fi

frozen=""
on_exit() {
  local rc=$?
  for host in "$OLD" "$NEW"; do "${ssh_cmd[@]}" -O exit "$host" 2>/dev/null || true; done
  rm -rf "$ctl"
  if [ "$rc" != 0 ] && [ -n "$frozen" ]; then
    printf '\n\033[31mСтарый сервер заморожен, работа не перенесена. Вернуть его в работу:\n  %s rollback\033[0m\n\n' "$0" >&2
  fi
}
trap on_exit EXIT

on_old() { "${ssh_cmd[@]}" "$OLD" "$@"; }
on_new() { "${ssh_cmd[@]}" "$NEW" "$@"; }

# Общее начало удалённых сценариев. Они приходят через stdin, поэтому всё, что
# умеет читать вход, запускается с </dev/null: иначе команда съедает остаток
# сценария, и он молча кончается с кодом 0 (так «выкатилась» v1.16.1).
read -r -d '' REMOTE_LIB <<'LIB' || true
set -euo pipefail
die() { echo "$*" >&2; exit 1; }
dir="$(systemctl show quizzy-backup.service -p WorkingDirectory --value 2>/dev/null || true)"
# на новом сервере до install каталога ещё нет: check работает и там
cd "${dir:-/opt/quizzy}" 2>/dev/null || cd /
c() { docker compose --env-file .env.docker "$@" </dev/null; }
val() { sed -n "s/^$1=//p" .env.docker | tail -n 1; }
# окружение службы копий — тем же разбором, что в deploy.yml
load_backup_env() {
  set -a
  for f in $(systemctl show quizzy-backup.service -p EnvironmentFiles --value | awk '{print $1}'); do
    [ -r "$f" ] && . "$f"
  done
  eval "unit_env=( $(systemctl show quizzy-backup.service -p Environment --value) )"
  for kv in ${unit_env[@]+"${unit_env[@]}"}; do export "$kv"; done
  set +a
}
# отпечаток данных: число строк, журнал доступа до последней записи, миграции
db_state() {
  c exec -T postgres psql -U quizzy -d quizzy -tA -c "select (select count(*) from users) || ' ' || (select count(*) from responses) || ' ' || (select count(*) from audit_log) || ' ' || coalesce((select entry_hash from audit_log where seq is not null order by seq desc limit 1), '-') || ' ' || (select count(*) from drizzle.\"__drizzle_migrations\")"
}
LIB

# remote <хост> [ПЕРЕМЕННАЯ=значение …] — тело сценария на stdin
remote() {
  local host="$1"; shift
  { printf '%s\n' "$REMOTE_LIB"; cat; } | "${ssh_cmd[@]}" "$host" "$* bash -s"
}

# Цель переезда — со своей отметкой, старый — без неё, и это разные машины
need_target() {
  [ "$(on_old 'cat /etc/machine-id')" != "$(on_new 'cat /etc/machine-id')" ] \
    || die "OLD и NEW — одна и та же машина."
  on_new "[ -f $MARK ]" || die "На $NEW нет отметки цели переезда: либо не было install, либо переезд завершён. База там не тронута."
  if on_old "[ -f $MARK ]"; then die "На $OLD стоит отметка цели переезда — OLD и NEW перепутаны?"; fi
  remote "$OLD" <<<'systemctl cat quizzy-backup.service >/dev/null' || die "На $OLD нет службы quizzy-backup."
}

# Окружение целиком; новое становится на место только непустым. Предел ядер
# расшифровщика приводится сразу: значение старого сервера больше ядер нового
# не даст создать контейнер, и cutover встал бы уже после заморозки старого.
push_env() {
  remote "$OLD" <<<'cat .env.docker' \
    | on_new "umask 077; cat > $TARGET/.env.docker.part && [ -s $TARGET/.env.docker.part ] && mv $TARGET/.env.docker.part $TARGET/.env.docker"
  on_new "cd $TARGET && bash scripts/transcriber-cpus.sh .env.docker </dev/null"
}

# Снимок старого: свой каталог, в ротацию копий не входит. В stdout — путь
snapshot_old() {
  remote "$OLD" <<'REMOTE'
load_backup_env
BACKUP_KIND=premove bash scripts/backup.sh </dev/null >&2
ls -1t "$BACKUP_DIR/premove" | head -n 1 | sed "s|^|$BACKUP_DIR/premove/|"
REMOTE
}

sha_of() { "${ssh_cmd[@]}" "$1" "sha256sum '$2'" | cut -d' ' -f1; }

move_file() {
  local f="$1" a b
  on_new "install -d -m 700 '$(dirname "$f")'"
  on_old "cat '$f'" | on_new "umask 077; cat > '$f.part' && mv '$f.part' '$f'"
  a="$(sha_of "$OLD" "$f")"; b="$(sha_of "$NEW" "$f")"
  [ -n "$a" ] && [ "$a" = "$b" ] || die "Снимок доехал с другой суммой: $f"
}

# Чистая база, снимок, права роли приложения. Приложение на новом остановлено.
restore_new() {
  remote "$NEW" "FILE='$1' MARK='$MARK'" <<'REMOTE'
[ -f "$MARK" ] || die "нет отметки цели переезда — базу не трогаю"
load_backup_env
c stop api transcriber web
c exec -T postgres psql -U quizzy -d postgres -v ON_ERROR_STOP=1 \
  -c 'drop database if exists quizzy with (force)' -c 'create database quizzy'
bash scripts/restore.sh "$FILE" </dev/null
c run --rm -T provision
REMOTE
}

volume_path() { remote "$1" <<<"docker volume inspect -f '{{.Mountpoint}}' quizzy_$2"; }

# число файлов и сумма размеров: каталоги на разных ФС весят по-разному
tree_size() {
  "${ssh_cmd[@]}" "$1" "cd '$2' && find . -type f -printf '%s\n' | awk '{ n++; s += \$1 } END { printf \"%d файлов, %.0f байт\n\", n, s }'"
}

# strict — старый заморожен, и расхождение значит потерю, а не свежую запись
copy_volume() {
  local name="$1" strict="${2:-}" from to a b
  from="$(volume_path "$OLD" "$name")"; to="$(volume_path "$NEW" "$name")"
  [ -n "$from" ] && [ -n "$to" ] || die "Нет тома quizzy_$name."
  on_new "[ -f $MARK ] && find '$to' -mindepth 1 -delete"
  # код 1 у tar — файл менялся при чтении: на живом старом это штатно, а
  # в строгом проходе расхождение поймает сверка ниже
  on_old "tar -C '$from' --numeric-owner -cf - . || [ \$? = 1 ]" | on_new "tar -C '$to' --numeric-owner -xpf -"
  a="$(tree_size "$OLD" "$from")"; b="$(tree_size "$NEW" "$to")"
  echo "  том $name: старый — $a; новый — $b"
  if [ -n "$strict" ] && [ "$a" != "$b" ]; then die "Том $name доехал не целиком."; fi
}

# Копии базы, вся история. Внешней копии может не быть, и тогда, кроме
# старого диска, истории нет нигде.
copy_backups() {
  local dir
  dir="$(remote "$NEW" <<<'load_backup_env; echo "$BACKUP_DIR"')"
  on_old "tar -C '$dir' --numeric-owner --exclude='*.part' -cf - . || [ \$? = 1 ]" \
    | on_new "install -d -m 700 '$dir' && tar -C '$dir' --numeric-owner -xpf -"
}

# start_new quiet|live: подъём, ответ приложения, политики строк, цепочка журнала
start_new() {
  local prefix=""
  [ "$1" = quiet ] && prefix="$QUIET"
  remote "$NEW" "$prefix WANT_SCHEDULER='$([ "$1" = quiet ] && echo 0 || echo 1)'" <<'REMOTE'
c up -d
ready=""
for _ in $(seq 1 60); do
  if c exec -T api bun -e "fetch('http://localhost:3001/health/ready').then(r=>r.json()).then(j=>process.exit(j.rls?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 5
done
[ -n "$ready" ] || { c logs --tail 40 api; die "приложение не ответило за пять минут, или политики строк не действуют"; }
got="$(c exec -T api printenv SCHEDULER_ENABLED | tr -d '\r')"
if [ "$got" != "$WANT_SCHEDULER" ]; then
  c stop api transcriber
  die "SCHEDULER_ENABLED=$got вместо $WANT_SCHEDULER — приложение остановлено"
fi
echo "  ✓ приложение отвечает, планировщик: $got"
c run --rm --no-deps -T api bun apps/api/src/rlsReport.ts
c run --rm --no-deps -T api bun apps/api/src/auditReport.ts
REMOTE
}

cmd_check() {
  local bad=0 domain smtp offsite
  say "Старый сервер: $OLD"
  remote "$OLD" <<'REMOTE' || bad=1
[ -f .env.docker ] || die "нет .env.docker в $PWD"
. /etc/os-release
echo "  $PRETTY_NAME, $(uname -m); ядер $(nproc), память $(free -m | awk '/^Mem:/{print $2}') МБ; каталог $PWD"
echo "  версия $(val QUIZZY_VERSION), образы $(val QUIZZY_IMAGE_PREFIX)"
for v in pgdata recordings caddy_data; do
  m="$(docker volume inspect -f '{{.Mountpoint}}' "quizzy_$v")" || die "нет тома quizzy_$v"
  echo "  том $v: $(du -sh "$m" | cut -f1)"
done
load_backup_env
echo "  копии $BACKUP_DIR: $(du -sh "$BACKUP_DIR" | cut -f1)"
if [ -n "${OFFSITE_URL:-}" ]; then
  echo "  внешняя копия настроена"
else
  echo "  ВНИМАНИЕ: внешней копии нет — все копии базы лежат на этом сервере"
fi
[ ! -f docker-compose.override.yml ] || echo "  ВНИМАНИЕ: есть docker-compose.override.yml — перенести руками"
for f in /etc/cron.d/* /var/spool/cron/root /var/spool/cron/crontabs/root; do
  if [ -f "$f" ] && grep -qi quizzy "$f"; then echo "  ВНИМАНИЕ: задание quizzy в $f — на новом его не будет"; fi
done
c ps --format '  {{.Service}}: {{.State}}'
REMOTE

  domain="$(remote "$OLD" <<<'val SITE_ADDRESS')"
  smtp="$(remote "$OLD" <<<'val SMTP_URL' | sed -nE 's#^[a-z]+://([^@/]*@)?([^/:?]+)(:([0-9]+))?.*#\2:\4#p')"
  offsite="$(remote "$OLD" <<<'load_backup_env; printf "%s" "${OFFSITE_URL:-}"' | sed -nE 's#^https?://([^/]+).*#\1:443#p')"

  say "Новый сервер: $NEW"
  remote "$NEW" "SMTP='$smtp' OFFSITE='$offsite'" <<'REMOTE' || bad=1
. /etc/os-release
bad=0
echo "  $PRETTY_NAME, $(uname -m); ядер $(nproc), память $(free -m | awk '/^Mem:/{print $2}') МБ, свободно на диске $(df -BG --output=avail / | tail -n 1 | tr -d ' ')"
# образы собираются только под amd64
[ "$(uname -m)" = x86_64 ] || { echo "  НЕ ГОДИТСЯ: нужен x86_64 — образов под $(uname -m) нет"; bad=1; }
command -v apt-get >/dev/null || { echo "  НЕ ГОДИТСЯ: установщик рассчитан на Debian/Ubuntu"; bad=1; }
[ "$(df -BG --output=avail / | tail -n 1 | tr -dc 0-9)" -ge 20 ] || { echo "  НЕ ГОДИТСЯ: меньше 20 ГБ свободно"; bad=1; }
[ -s /root/.ssh/authorized_keys ] || echo "  ВНИМАНИЕ: у root нет ssh-ключа — вход по паролю останется открытым"
if [ ! -f /root/.quizzy-move-target ] && { [ -e /opt/quizzy/.env.docker ] || systemctl cat quizzy-backup.service >/dev/null 2>&1; }; then
  echo "  НЕ ГОДИТСЯ: здесь уже есть рабочая установка"; bad=1
fi
# Исходящие: поставщики нередко закрывают почтовые порты на новых счетах
for h in ghcr.io:443 huggingface.co:443 api.telegram.org:443 exp.host:443 $SMTP $OFFSITE; do
  [ "${h##*:}" = "" ] && h="${h}587"
  if timeout 6 bash -c "</dev/tcp/${h%:*}/${h##*:}" 2>/dev/null; then
    echo "  исходящие $h: да"
  else
    echo "  НЕ ГОДИТСЯ: исходящие $h закрыты"; bad=1
  fi
done
[ "$bad" = 0 ]
REMOTE

  if [ -n "$domain" ] && command -v dig >/dev/null 2>&1; then
    say "DNS"
    dig +noall +answer "$domain" A "www.$domain" A | sed 's/^/  /'
    echo "  TTL до заморозки опустить до 300; AAAA, если появится, менять вместе с A."
  fi
  [ "$bad" = 0 ] || die "Есть препятствия — см. выше."
  say "Препятствий нет."
}

cmd_install() {
  [ "$(on_old 'cat /etc/machine-id')" != "$(on_new 'cat /etc/machine-id')" ] || die "OLD и NEW — одна и та же машина."
  # Служба копий — признак установки в любом каталоге: на проверке одного
  # /opt/quizzy перепутанные адреса ставили отметку на рабочий сервер
  on_new "[ -f $MARK ] || { [ ! -e $TARGET/.env.docker ] && ! systemctl cat quizzy-backup.service >/dev/null 2>&1; }" \
    || die "На $NEW уже есть установка без отметки цели переезда: это может быть рабочий сервер."
  if on_old "[ -f $MARK ]"; then die "На $OLD стоит отметка цели переезда — OLD и NEW перепутаны?"; fi

  say "Хранилище и окружение старого сервера"
  on_new "touch $MARK && chmod 600 $MARK"
  on_new "command -v git >/dev/null || { apt-get update -q >/dev/null && apt-get install -y -q git ca-certificates >/dev/null; }"
  on_new "[ -d $TARGET/.git ] || git clone -q '$REPO' $TARGET"
  push_env
  # Парольная фраза — та же: иначе ни одну копию старого сервера не открыть.
  # Значения собираются разбором окружения службы и в журнал не попадают.
  remote "$OLD" <<'REMOTE' | on_new "umask 077; cat > $BACKUP_ENV.part && mv $BACKUP_ENV.part $BACKUP_ENV"
load_backup_env
[ -n "${BACKUP_PASSPHRASE:-}" ] || die "у службы копий нет BACKUP_PASSPHRASE"
# В двойных кавычках с обратной косой перед \ " $ `: файл читают и оболочка
# выкатки, и systemd, и это единственная запись, которую оба понимают
# одинаково. Шелловское '\'' systemd разбирает иначе и молча меняет значение,
# а фраза на старом заводилась руками и может содержать что угодно.
env | grep -E '^(BACKUP_PASSPHRASE|BACKUP_DIR|DATABASE_URL|OFFSITE_[A-Z_]+)=' \
  | sed -E -e 's/([\\"$`])/\\\1/g' -e 's/^([A-Z_]+)=(.*)$/\1="\2"/'
REMOTE

  say "Установка на $NEW (образы версии старого сервера, планировщик выключен)"
  local domain
  domain="$(remote "$OLD" <<<'val SITE_ADDRESS')"
  on_new "$QUIET bash $TARGET/scripts/server-install.sh '$domain' </dev/null"
  say "Поставлено. Пароль администратора выше не нужен: база будет заменена копией."
  echo "Секреты GitHub и DNS из итога установщика пока не трогайте. Дальше: $0 rehearse"
}

cmd_rehearse() {
  need_target
  local file
  say "Версия и окружение"
  push_env
  remote "$NEW" <<<'c pull'
  say "Снимок на старом (он продолжает работать)"
  file="$(snapshot_old)"
  move_file "$file"
  say "Восстановление на новом"
  restore_new "$file"
  say "Записи приёмов, сертификаты, копии базы"
  copy_volume recordings
  copy_volume caddy_data
  copy_backups
  say "Запуск без планировщика и почты"
  start_new quiet
  say "Данные"
  echo "  старый: $(remote "$OLD" <<<'db_state')"
  echo "  новый:  $(remote "$NEW" <<<'db_state')"
  say "Проба готова. Сверху — состояние, старый успел уйти вперёд, это нормально."
  local domain host="${NEW#*@}"
  domain="$(remote "$OLD" <<<'val SITE_ADDRESS')"
  echo "Проверка снаружи, с настоящим сертификатом:"
  echo "  curl --resolve $domain:443:$host https://$domain/health/ready"
  echo "В браузере: строка «$host $domain» в /etc/hosts, потом убрать. Только смотреть: это копия,"
  echo "и пуши с действий в консоли уходят настоящим людям."
}

cmd_cutover() {
  need_target
  local domain file a b answer="${MOVE_CONFIRM:-}"
  domain="$(remote "$OLD" <<<'val SITE_ADDRESS')"
  [ -n "$answer" ] || read -r -p "Приложение на старом сервере будет остановлено. Введите домен для подтверждения: " answer
  [ "$answer" = "$domain" ] || die "Домен не совпал — ничего не сделано."

  # всё долгое и безобидное — до заморозки: простой идёт только дальше
  say "Подготовка: версия и окружение"
  push_env
  remote "$NEW" <<<'c pull'

  say "Заморозка старого"
  frozen=1
  remote "$OLD" <<<'c stop api transcriber'
  say "Финальный снимок"
  file="$(snapshot_old)"
  move_file "$file"
  say "Восстановление на новом"
  restore_new "$file"
  say "Записи приёмов, сертификаты, копии базы"
  copy_volume recordings strict
  copy_volume caddy_data
  copy_backups

  say "Сверка данных"
  a="$(remote "$OLD" <<<'db_state')"; b="$(remote "$NEW" <<<'db_state')"
  echo "  старый: $a"
  echo "  новый:  $b"
  [ -n "$a" ] && [ "$a" = "$b" ] || die "Данные не совпали — новый не запущен."

  say "Запуск в полную работу"
  start_new live
  on_new "rm -f $MARK"
  frozen=""
  # старый больше не снимает копий, новый снимает первую настоящую: снимок
  # пустой базы от установки иначе остался бы самым свежим для проверки
  remote "$OLD" <<<'systemctl disable --now quizzy-backup.timer quizzy-verify.timer 2>/dev/null || true'
  remote "$NEW" <<<'systemctl start quizzy-backup.service' \
    || echo "ВНИМАНИЕ: первый снимок на новом не снялся — journalctl -u quizzy-backup.service" >&2

  say "Новый сервер работает."
  echo "1. Сейчас: A-записи @ и www → ${NEW#*@}."
  echo "2. Когда домен показывает на новый: $0 secrets"
  echo "3. Старый не выключать, пока домен не разойдётся (TTL). rollback — только пока домен не переключён."
}

cmd_rollback() {
  # После переключения домена новый уже принимает записи, и откат их потеряет
  local domain
  domain="$(remote "$OLD" <<<'val SITE_ADDRESS')"
  if command -v dig >/dev/null 2>&1 && [ "$(dig +short A "$domain" | tail -n 1)" = "${NEW#*@}" ] && [ -z "${FORCE_ROLLBACK:-}" ]; then
    die "Домен уже показывает на новый сервер: записанное там откат потеряет. Осознанно: FORCE_ROLLBACK=1 $0 rollback"
  fi
  on_new "touch $MARK && chmod 600 $MARK"
  say "Новый останавливается первым: два живых экземпляра — двойные рассылки"
  remote "$NEW" <<<'c stop api transcriber'
  say "Старый возвращается в работу"
  remote "$OLD" <<'REMOTE'
c up -d
systemctl enable --now quizzy-backup.timer 2>/dev/null || true
systemctl enable --now quizzy-verify.timer 2>/dev/null || true
REMOTE
  say "Старый работает."
  echo "Записанное на новом после cutover сюда не возвращается: откат — только пока домен не переключён."
}

cmd_secrets() {
  command -v gh >/dev/null 2>&1 || die "Нужен gh, вошедший в GitHub."
  on_new "[ ! -f $MARK ]" || die "cutover не завершён: выкатка на этот сервер сняла бы тишину с копии."
  local host="${VPS_HOST:-${NEW#*@}}" user="${NEW%@*}"
  [ "$user" != "$NEW" ] || user=root
  # Отпечаток берётся внутри уже проверенного ssh, а не сканом снаружи
  on_new "ssh-keyscan -t ed25519 127.0.0.1 2>/dev/null" | sed "s/^127\.0\.0\.1/$host/" | gh secret set VPS_KNOWN_HOSTS -R "$GH_REPO"
  on_new "cat /root/.ssh/quizzy_actions" | gh secret set VPS_SSH_KEY -R "$GH_REPO"
  printf '%s' "$host" | gh secret set VPS_HOST -R "$GH_REPO"
  printf '%s' "$user" | gh secret set VPS_USER -R "$GH_REPO"
  printf '%s' "$TARGET" | gh secret set VPS_PATH -R "$GH_REPO"
  say "Выкатка и обслуживание смотрят на $host."
  echo "Проверка: Actions → «Обслуживание» → backup-status, rls-check, audit-verify, backup-verify."
}

"cmd_$cmd"
