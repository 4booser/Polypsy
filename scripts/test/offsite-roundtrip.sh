#!/usr/bin/env bash
# Проверка внешней копии (scripts/offsite.sh) на заглушке S3:
#   без OFFSITE_URL — put и check молча нули;
#   put кладёт файл под ключом kind/имя и сверяет размер;
#   check видит местную копию, которой нет снаружи, и копию другого размера;
#   backup.sh после снимка сам зовёт put (проверяется подменой pg_dump).
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

[ "$fail" = 0 ] && echo "внешняя копия: все проверки прошли" || { echo "внешняя копия: есть провалы" >&2; exit 1; }
