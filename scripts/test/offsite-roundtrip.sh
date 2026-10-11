#!/usr/bin/env bash
# Проверка внешней копии (scripts/offsite.sh) на заглушке S3:
#   без OFFSITE_URL — put и check молча нули;
#   put кладёт файл под ключом kind/имя и сверяет размер;
#   check видит местную копию, которой нет снаружи, и копию другого размера;
#   backup.sh после снимка сам зовёт put (проверяется подменой pg_dump);
#   отказ внешней копии не отменяет местную, ротацию и снимок выкатки, а
#   оповещает: через приложение, иначе прямо в Telegram (заглушка та же);
#   отказ служб копий и проверки доходит до scripts/ops-alert.sh (#159).
#
#   ./scripts/test/offsite-roundtrip.sh
# Нужны: bun, curl ≥ 7.75, gpg, zstd. Базы не нужны: pg_dump и pg_restore
# подменяются заглушками в PATH.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'kill "${stub_pid:-0}" 2>/dev/null || true; rm -rf "$tmp"' EXIT
fail=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; fail=1; }

unset OFFSITE_URL OFFSITE_KEY_ID OFFSITE_SECRET OFFSITE_REGION
export BACKUP_DIR="$tmp/backups"
mkdir -p "$BACKUP_DIR/daily" "$BACKUP_DIR/weekly"

echo "1. без OFFSITE_URL"
out="$("$repo/scripts/offsite.sh" put /nonexistent)" && ok "put — ноль и «пропуск»: $out" || bad "put без настройки должен выходить нулём"
"$repo/scripts/offsite.sh" check >/dev/null && ok "check — ноль" || bad "check без настройки должен выходить нулём"

echo "2. заглушка S3"
port=$(( 20000 + RANDOM % 20000 ))
bun "$repo/scripts/test/offsite-stub.ts" "$port" > "$tmp/stub.log" 2>&1 &
stub_pid=$!
for _ in $(seq 1 50); do grep -q '^stub' "$tmp/stub.log" 2>/dev/null && break; sleep 0.1; done
export OFFSITE_URL="http://127.0.0.1:$port/bucket" OFFSITE_KEY_ID="test-key" OFFSITE_SECRET="test-secret" OFFSITE_REGION="auto"

head -c 5000 /dev/urandom > "$BACKUP_DIR/daily/quizzy_2026-10-04_030000.dump.zst.gpg"
head -c 7000 /dev/urandom > "$BACKUP_DIR/weekly/quizzy_2026-10-05_030000.dump.zst.gpg"
"$repo/scripts/offsite.sh" put "$BACKUP_DIR/daily/quizzy_2026-10-04_030000.dump.zst.gpg" "$BACKUP_DIR/weekly/quizzy_2026-10-05_030000.dump.zst.gpg" > "$tmp/put.log" \
  && ok "put двух файлов" || bad "put: $(cat "$tmp/put.log")"
"$repo/scripts/offsite.sh" list | grep -qx "5000 daily/quizzy_2026-10-04_030000.dump.zst.gpg" && ok "list: ключ kind/имя и размер" || bad "list не показал файл: $("$repo/scripts/offsite.sh" list)"
"$repo/scripts/offsite.sh" check > "$tmp/check.log" && ok "check: всё на месте — $(tail -1 "$tmp/check.log")" || bad "check должен быть зелёным: $(cat "$tmp/check.log")"

echo "3. расхождения"
head -c 100 /dev/urandom > "$BACKUP_DIR/daily/quizzy_2026-10-06_030000.dump.zst.gpg"
if "$repo/scripts/offsite.sh" check > "$tmp/check.log"; then bad "check не заметил копию, которой нет снаружи"; else
  grep -q 'quizzy_2026-10-06' "$tmp/check.log" && ok "check: назвал копию без внешней" || bad "check упал, но не назвал файл"; fi
rm "$BACKUP_DIR/daily/quizzy_2026-10-06_030000.dump.zst.gpg"
head -c 4999 /dev/urandom > "$BACKUP_DIR/daily/quizzy_2026-10-04_030000.dump.zst.gpg"
"$repo/scripts/offsite.sh" check > "$tmp/check.log" && bad "check не заметил другой размер" || ok "check: другой размер — отказ"

echo "4. без подписи"
OFFSITE_KEY_ID="" "$repo/scripts/offsite.sh" list >/dev/null 2>&1 && bad "list без ключа прошёл" || ok "без ключа — отказ"

echo "5. backup.sh зовёт put"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf 'PGDMP-stub-%s' "$(date +%s%N)"
EOF
cat > "$tmp/bin/pg_restore" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null; echo "1; 0 0 TABLE public stub"
EOF
chmod +x "$tmp/bin/"*
PATH="$tmp/bin:$PATH" DATABASE_URL=postgres://stub BACKUP_PASSPHRASE=test-phrase BACKUP_KIND=upgrade/test \
  "$repo/scripts/backup.sh" > "$tmp/backup.log" 2>&1 && ok "backup.sh прошёл" || bad "backup.sh: $(cat "$tmp/backup.log")"
grep -q 'внешняя копия: test/quizzy_' "$tmp/backup.log" && ok "после снимка ушла внешняя копия" || bad "backup.sh не позвал offsite: $(cat "$tmp/backup.log")"

echo "6. отказ внешней копии не отменяет местную, ротацию и выкатку; оповещение уходит (#159)"
# Каталог установки, как на сервере: состав и .env.docker с каналом Telegram.
# docker — заглушка: пишет вызов и выходит с DOCKER_RC (1 — приложение не
# ответило, и скрипт оповещения идёт в Telegram сам). Telegram — та же
# заглушка, что S3 (TELEGRAM_API).
inst="$tmp/inst"
mkdir -p "$inst"
printf 'services: {}\n' > "$inst/docker-compose.yml"
printf 'TELEGRAM_BOT_TOKEN=tg-test-token\nTELEGRAM_CHAT_ID=-100500\n' > "$inst/.env.docker"
cat > "$tmp/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$DOCKER_LOG"
exit "${DOCKER_RC:-1}"
EOF
chmod +x "$tmp/bin/docker"
export DOCKER_LOG="$tmp/docker.log" TELEGRAM_API="http://127.0.0.1:$port"
: > "$DOCKER_LOG"
fb="$tmp/fb"
# сверх предела в каждом каталоге — ротация обязана их подрезать
for spec in daily:8 weekly:5 monthly:13 predeploy:11; do
  kind="${spec%%:*}"; mkdir -p "$fb/$kind"
  for i in $(seq 1 "${spec#*:}"); do
    f="$fb/$kind/quizzy_2026-01-$(printf '%02d' "$i")_030000.dump.zst.gpg"
    printf 'прежняя %s %s' "$kind" "$i" > "$f"; touch -t "202601$(printf '%02d' "$i")0300" "$f"
  done
done
count() { find "$fb/$1" -type f | wc -l | tr -d ' '; }
tg_sent() { grep -c '^telegram ' "$tmp/stub.log" || true; }
tg_before="$(tg_sent)"
# хранилище недоступно: порт, где никто не слушает
(cd "$inst" && PATH="$tmp/bin:$PATH" OFFSITE_URL="http://127.0.0.1:9/bucket" DATABASE_URL=postgres://stub \
  BACKUP_DIR="$fb" BACKUP_PASSPHRASE=test-phrase "$repo/scripts/backup.sh" > "$tmp/nightly.log" 2>&1) \
  && ok "ночная копия при недоступном хранилище — код успеха" || bad "backup.sh упал из-за внешней копии: $(cat "$tmp/nightly.log")"
local_copy="$(sed -n 's/^бэкап: \([^ ]*\) .*/\1/p' "$tmp/nightly.log")"
[ -n "$local_copy" ] && [ -f "$local_copy" ] && ok "местная копия на месте: ${local_copy#"$fb"/}" || bad "местной копии нет: $(cat "$tmp/nightly.log")"
[ "$(count daily)/$(count weekly)/$(count monthly)" = "7/4/12" ] && ok "ротация прошла: 7/4/12" \
  || bad "ротация не прошла: $(count daily)/$(count weekly)/$(count monthly)"
grep -q 'внешняя копия не легла' "$tmp/nightly.log" && ok "отказ виден в журнале" || bad "в журнале нет отказа: $(cat "$tmp/nightly.log")"
grep -q 'exec -T api bun apps/api/src/opsNotify.ts' "$DOCKER_LOG" && ok "сначала — через приложение (exec -T)" || bad "приложение не спрошено: $(cat "$DOCKER_LOG")"
grep -q '^telegram bot=tg-test-token chat=-100500 text=".*зовнішня копія' "$tmp/stub.log" \
  && ok "приложение не ответило — оповещение ушло в Telegram с хоста" || bad "в Telegram ничего: $(cat "$tmp/stub.log")"
grep -q 'tg-test-token' "$tmp/nightly.log" && bad "токен бота попал в журнал" || ok "токена бота в журнале нет"

tg_mid="$(tg_sent)"
(cd "$inst" && PATH="$tmp/bin:$PATH" OFFSITE_URL="http://127.0.0.1:9/bucket" DATABASE_URL=postgres://stub \
  BACKUP_DIR="$fb" BACKUP_PASSPHRASE=test-phrase BACKUP_KIND=predeploy "$repo/scripts/backup.sh" > "$tmp/predeploy.log" 2>&1) \
  && ok "снимок выкатки при недоступном хранилище — код успеха, выкатка идёт дальше" || bad "снимок выкатки упал: $(cat "$tmp/predeploy.log")"
[ "$(count predeploy)" = "10" ] && ok "срок снимков выкатки соблюдён: 10" || bad "predeploy/: $(count predeploy)"
[ "$(tg_sent)" -gt "$tg_mid" ] && ok "и об этом отказе — оповещение" || bad "оповещения о снимке выкатки нет"

# контроль: хранилище доступно — ни оповещения, ни вызова приложения
: > "$DOCKER_LOG"
tg_ok="$(tg_sent)"
(cd "$inst" && PATH="$tmp/bin:$PATH" DATABASE_URL=postgres://stub BACKUP_DIR="$fb" BACKUP_PASSPHRASE=test-phrase \
  "$repo/scripts/backup.sh" > "$tmp/fine.log" 2>&1) && ok "контроль: исправная внешняя копия — успех" || bad "контроль упал: $(cat "$tmp/fine.log")"
[ "$(tg_sent)" = "$tg_ok" ] && [ ! -s "$DOCKER_LOG" ] && ok "контроль: без отказа никого не будят" || bad "оповещение без отказа"
[ "$tg_before" -lt "$tg_ok" ] || bad "счёт сообщений Telegram не рос — проверка выше ничего не доказывает"

echo "7. оповещение об отказе службы (OnFailure= → ops-alert.sh --unit)"
: > "$DOCKER_LOG"
tg_unit="$(tg_sent)"
(cd "$inst" && PATH="$tmp/bin:$PATH" DOCKER_RC=0 "$repo/scripts/ops-alert.sh" --unit quizzy-verify.service > "$tmp/unit.log" 2>&1) \
  && ok "приложение ответило — код успеха" || bad "ops-alert.sh: $(cat "$tmp/unit.log")"
grep -q 'opsNotify.ts Збій: перевірка відновлюваності копії (quizzy-verify.service)' "$DOCKER_LOG" \
  && ok "тема называет службу" || bad "тема не та: $(cat "$DOCKER_LOG")"
[ "$(tg_sent)" = "$tg_unit" ] && ok "приложение доставило — с хоста в Telegram не дублируется" || bad "дубль в Telegram"
mkdir -p "$tmp/bare" && printf 'services: {}\n' > "$tmp/bare/docker-compose.yml" && printf 'POSTGRES_PASSWORD=x\n' > "$tmp/bare/.env.docker"
if (cd "$tmp/bare" && PATH="$tmp/bin:$PATH" "$repo/scripts/ops-alert.sh" --unit quizzy-backup.service > "$tmp/bare.log" 2>&1); then
  bad "некуда слать, а код успеха"
else
  grep -q 'Telegram в .env.docker не настроен' "$tmp/bare.log" && ok "некуда слать — отказ с причиной" || bad "отказ без причины: $(cat "$tmp/bare.log")"
fi
n_onfailure="$(grep -c '^OnFailure=quizzy-alert@%n.service$' "$repo/scripts/server-install.sh" || true)"
[ "$n_onfailure" = "2" ] && ok "службы копий и проверки: OnFailure=quizzy-alert@%n.service" || bad "OnFailure у служб: $n_onfailure из 2"
# shellcheck disable=SC2016 # $TARGET — буквально, как в тексте юнита в server-install.sh
grep -q '^ExecStart=$TARGET/scripts/ops-alert.sh --unit %i$' "$repo/scripts/server-install.sh" \
  && ok "quizzy-alert@.service зовёт ops-alert.sh --unit" || bad "нет службы quizzy-alert@"
grep -Eq 'scp .*scripts/ops-alert\.sh' "$repo/.github/workflows/deploy.yml" && ok "выкатка везёт ops-alert.sh на сервер" || bad "deploy.yml не везёт ops-alert.sh"

[ "$fail" = 0 ] && echo "внешняя копия: все проверки прошли" || { echo "внешняя копия: есть провалы" >&2; exit 1; }
