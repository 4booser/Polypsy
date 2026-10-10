#!/usr/bin/env bash
# Сквозная проверка резервных копий: снять → восстановить → сверить →
# прогнать проверку восстановимости → подменить запись журнала в копии и
# убедиться, что проверка это ловит.
#
#   ./scripts/test/backup-roundtrip.sh
#   PG_BASE=postgres://user@localhost:5432 ./scripts/test/backup-roundtrip.sh
#
# Сценарием, а не тестом в apps/api/test: проверяются сами скрипты оболочки
# с настоящими pg_dump, gpg и zstd, и ровно тем путём, каким их зовут cron,
# обслуживание и upgrade-instances.sh. Ветка age в backup.sh год считалась
# работающей, потому что ни разу не проходила цикл «снять → восстановить»
# целиком; этот сценарий проходит его для каждого пути, которым копия
# появляется на диске.
#
# Нужны: PostgreSQL, где PG_BASE — суперпользователь (сценарий заводит и
# сносит базы и выключает триггер неизменяемости журнала, чтобы подменить
# запись), клиентские утилиты той же версии, gpg, zstd, bun и зависимости
# рабочей копии (bun install). Базы quizzy_bk_<pid>_* и временный каталог
# удаляются за собой при любом исходе. Код возврата ненулевой, если не
# прошла хоть одна проверка.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$repo"

PG_BASE="${PG_BASE:-postgres://$(id -un)@localhost:5432}"
PG_BASE="${PG_BASE%/}"

# Окружение вызывающего не должно подменять то, что проверяется.
unset DATABASE_URL BACKUP_DIR BACKUP_PASSPHRASE BACKUP_KIND PG_EXEC APP_EXEC \
  APP_DB_HOST INSTANCES ENCRYPTION_KEY NODE_ENV \
  OFFSITE_URL OFFSITE_KEY_ID OFFSITE_SECRET OFFSITE_REGION

for tool in psql pg_dump pg_restore gpg zstd bun; do
  command -v "$tool" >/dev/null 2>&1 || { echo "нет $tool — сценарий не запустить" >&2; exit 2; }
done
[ -d node_modules ] || { echo "нет node_modules — сначала bun install" >&2; exit 2; }

prefix="quizzy_bk_$$_"
work="$(mktemp -d "${TMPDIR:-/tmp}/quizzy-bk.XXXXXX")"
# Все запуски скриптов — со своим TMPDIR: в конце он обязан быть пуст, то
# есть ни один скрипт не оставил открытого дампа во временных файлах.
mkdir -p "$work/tmp"
export TMPDIR="$work/tmp"

cleanup() {
  for db in $(psql "$PG_BASE/postgres" -XtAc "select datname from pg_database where starts_with(datname, '$prefix')" 2>/dev/null); do
    psql "$PG_BASE/postgres" -Xqc "drop database if exists \"$db\" with (force)" >/dev/null 2>&1 || true
  done
  rm -rf "$work"
}
trap cleanup EXIT

passed=0
failed=0
ok()  { passed=$((passed + 1)); echo "  ✓ $1"; }
bad() {
  failed=$((failed + 1)); echo "  ✗ $1"
  if [ -n "${2:-}" ] && [ -f "$2" ]; then sed 's/^/      | /' "$2" | tail -n 15; fi
  return 0
}
section() { echo; echo "── $1"; }
finish() {
  echo
  echo "итог: пройдено $passed, провалено $failed"
  [ "$failed" = "0" ]
}

# Сначала форма GNU, потом BSD — по той же причине, что в verify-backup.sh.
mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# Отпечаток содержимого базы: по каждой таблице — число строк и md5 всех
# строк в устойчивом порядке, плюс значения последовательностей. Совпавший
# отпечаток — это «восстановилось всё и ровно то», а не «таблицы на месте».
fingerprint() {
  psql "$1" -XtAq -c "
    select t.table_schema || '.' || t.table_name || ' ' ||
      (xpath('/row/f/text()', query_to_xml(format(
        'select count(*) || '':'' || md5(coalesce(string_agg(r::text, chr(10) order by r::text), '''')) as f from %I.%I r',
        t.table_schema, t.table_name), false, true, '')))[1]::text
    from information_schema.tables t
    where t.table_schema in ('public', 'drizzle') and t.table_type = 'BASE TABLE'
    order by 1"
  psql "$1" -XtAq -c "
    select schemaname || '.' || sequencename || ' ' || coalesce(last_value::text, '-')
    from pg_sequences where schemaname in ('public', 'drizzle') order by 1"
}

newdb() { psql "$PG_BASE/postgres" -Xqc "create database \"$prefix$1\""; }

# Адрес с паролем: вывод скриптов не должен его содержать. При входе без
# пароля (trust) сервер лишний пароль пропускает — тогда подставляем свой;
# если PG_BASE уже с паролем — ищем в выводе его; иначе проверка пропускается.
rest="${PG_BASE#*://}"
secret=""
case "$rest" in
  *:*@*) secret="${rest%%@*}"; secret="${secret#*:}"; PG_URL="$PG_BASE" ;;
  *@*)
    try="${PG_BASE%%://*}://${rest%%@*}:bk-db-secret-$$@${rest#*@}"
    if psql "$try/postgres" -XtAc 'select 1' >/dev/null 2>&1; then
      PG_URL="$try"; secret="bk-db-secret-$$"
    else
      PG_URL="$PG_BASE"
    fi ;;
  *) PG_URL="$PG_BASE" ;;
esac
no_leak() { # файл вывода, что это
  if grep -qF "$pass" "$1"; then bad "$2: в выводе парольная фраза копий" "$1"
  elif [ -n "$secret" ] && grep -qF "$secret" "$1"; then bad "$2: в выводе пароль базы" "$1"
  else ok "$2: в выводе нет ни фразы, ни пароля базы"; fi
}

pass="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
marker="відкритий-текст-$$-маркер"
src="${prefix}src"
SRC_URL="$PG_URL/$src"

# ─────────────────────────────────────────────────────────────────────────────
section "исходная база: схема приложения, пользователь и журнал через код приложения"
newdb src
DATABASE_URL="$SRC_URL" bun apps/api/src/migrate.ts > "$work/migrate.log" 2>&1 \
  || { cat "$work/migrate.log"; exit 1; }
psql "$SRC_URL" -Xqc "insert into users (id, email, password_hash, first_name, last_name)
  values ('bk-user-$$', 'bk-$$@example.invalid', 'x', 'Тест', '$marker')"
# Журнал пишется функцией приложения, а не вставкой: хэши обязаны быть теми,
# что посчитало бы приложение, иначе проверка сверяет самодельное с
# самодельным.
DATABASE_URL="$SRC_URL" MARKER="$marker" bun -e '
  const { auditSystem } = await import("./apps/api/src/lib/audit.ts");
  const { client } = await import("./apps/api/src/db/index.ts");
  for (let i = 1; i <= 6; i++) {
    await auditSystem({ action: "survey.create", resourceType: "backup-test", resourceId: String(i),
      details: { n: i, note: process.env.MARKER + " " + i } });
  }
  await client.end();
' > "$work/seed.log" 2>&1 || { cat "$work/seed.log"; exit 1; }
n_audit="$(psql "$SRC_URL" -XtAc 'select count(*) from audit_log where seq is not null')"
if [ "$n_audit" = "6" ]; then ok "в журнале 6 цепных записей"; else bad "в журнале $n_audit записей вместо 6" "$work/seed.log"; fi
fp_src="$(fingerprint "$SRC_URL")"

# ─────────────────────────────────────────────────────────────────────────────
section "снятие копии (backup.sh), при установленном age"
# Подложный age в PATH: формат копии не должен зависеть от того, какие
# программы стоят на машине.
mkdir -p "$work/agebin"
printf '#!/bin/sh\necho called >> "%s/age-called"\nexit 1\n' "$work" > "$work/agebin/age"
chmod +x "$work/agebin/age"
if PATH="$work/agebin:$PATH" DATABASE_URL="$SRC_URL" BACKUP_DIR="$work/backups" \
     BACKUP_PASSPHRASE="$pass" ./scripts/backup.sh > "$work/backup.log" 2>&1; then
  ok "backup.sh завершился успешно"
else
  bad "backup.sh упал" "$work/backup.log"
fi
copy="$(find "$work/backups" -type f -name 'quizzy_*.dump.zst.gpg' 2>/dev/null | head -1 || true)"
others="$(find "$work/backups" -type f ! -name 'quizzy_*.dump.zst.gpg' | wc -l | tr -d ' ')"
if [ -n "$copy" ] && [ "$others" = "0" ]; then ok "ровно одна копия .gpg, без .part/.age: ${copy#$work/}"; else bad "копия .gpg не найдена или рядом лишние файлы ($others)" "$work/backup.log"; fi
if [ ! -e "$work/age-called" ]; then ok "age не вызывался"; else bad "backup.sh вызывал age"; fi
if [ -n "$copy" ] && [ "$(mode "$copy")" = "600" ] && [ "$(mode "$(dirname "$copy")")" = "700" ]; then
  ok "права: файл 600, каталог 700"
else
  bad "права копии $(mode "$copy" 2>/dev/null), каталога $(mode "$(dirname "$copy")" 2>/dev/null)"
fi
if [ -n "$copy" ] && ! LC_ALL=C grep -aqF "$marker" "$copy" && ! zstd -q -t "$copy" 2>/dev/null; then
  ok "в файле нет открытого текста и это не голый zstd"
else
  bad "в копии виден открытый текст или она не зашифрована"
fi
# grep -c, а не -q: -q выходит на первом совпадении, zstd и gpg выше по
# конвейеру получают SIGPIPE, и под pipefail исправная копия «не содержит
# данных» — в зависимости от времени и буфера (#165). -c дочитывает поток до
# конца, и код конвейера снова значит «расшифровалось, распаковалось, маркер
# есть»; GNU grep с выводом в /dev/null тоже выходит рано, поэтому счёт.
if [ -n "$copy" ] && n_marker="$(gpg --batch --quiet --pinentry-mode loopback --no-symkey-cache --passphrase-fd 3 \
     --decrypt "$copy" 3<<<"$pass" 2>/dev/null | zstd -q -d -c | LC_ALL=C grep -acF "$marker")" && [ "$n_marker" -gt 0 ]; then
  ok "внутри шифра — дамп с данными (маркер находится после расшифровки)"
else
  bad "расшифрованная копия не содержит данных"
fi
if grep -q 'объектов в архиве: [1-9]' "$work/backup.log"; then ok "проверка чтением прошла: $(grep -o 'объектов в архиве: [0-9]*' "$work/backup.log")"; else bad "нет строки о проверке чтением" "$work/backup.log"; fi
no_leak "$work/backup.log" "backup.sh"
if [ -z "$copy" ]; then
  echo "  копии нет — восстанавливать и проверять дальше нечего"
  finish
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
section "восстановление (restore.sh) и сверка с исходной"
newdb dst
DST_URL="$PG_URL/${prefix}dst"
if DATABASE_URL="$DST_URL" BACKUP_PASSPHRASE="$pass" ./scripts/restore.sh "$copy" > "$work/restore.log" 2>&1; then
  ok "restore.sh завершился успешно"
else
  bad "restore.sh упал" "$work/restore.log"
fi
if grep -qF "восстановлено в" "$work/restore.log" && grep -qF "${prefix}dst" "$work/restore.log"; then ok "итоговая строка называет базу"; else bad "итоговой строки нет" "$work/restore.log"; fi
no_leak "$work/restore.log" "restore.sh"
fp_dst="$(fingerprint "$DST_URL")"
if [ "$fp_src" = "$fp_dst" ]; then
  ok "содержимое совпадает с исходной: $(printf '%s\n' "$fp_src" | wc -l | tr -d ' ') таблиц и последовательностей"
else
  bad "содержимое восстановленной базы отличается"
  diff <(printf '%s\n' "$fp_src") <(printf '%s\n' "$fp_dst") | head -n 10 | sed 's/^/      | /' || true
fi

# ─────────────────────────────────────────────────────────────────────────────
section "отказы restore.sh не трогают базу"
fp_before="$(fingerprint "$DST_URL")"
if DATABASE_URL="$DST_URL" BACKUP_PASSPHRASE="wrong-$pass" ./scripts/restore.sh "$copy" > "$work/wrong.log" 2>&1; then
  bad "неверная фраза принята" "$work/wrong.log"
else
  ok "неверная фраза: отказ"
fi
broken="$work/broken.dump.zst.gpg"
cp "$copy" "$broken"
size="$(wc -c < "$broken" | tr -d ' ')"
printf 'X' | dd of="$broken" bs=1 seek=$((size / 2)) conv=notrunc 2>/dev/null
cmp -s "$copy" "$broken" && printf 'Y' | dd of="$broken" bs=1 seek=$((size / 2)) conv=notrunc 2>/dev/null
if DATABASE_URL="$DST_URL" BACKUP_PASSPHRASE="$pass" ./scripts/restore.sh "$broken" > "$work/broken.log" 2>&1; then
  bad "испорченная в середине копия принята" "$work/broken.log"
else
  ok "испорченная в середине копия: отказ"
fi
printf 'не дамп' > "$work/old.dump.zst.age"
if DATABASE_URL="$DST_URL" BACKUP_PASSPHRASE="$pass" ./scripts/restore.sh "$work/old.dump.zst.age" > "$work/age.log" 2>&1; then
  bad "файл .age принят" "$work/age.log"
elif grep -q 'данных в нём нет' "$work/age.log"; then
  ok "файл .age: отказ с объяснением"
else
  bad "файл .age: отказ без объяснения" "$work/age.log"
fi
if [ "$(fingerprint "$DST_URL")" = "$fp_before" ]; then ok "после трёх отказов база не изменилась"; else bad "отказавшее восстановление изменило базу"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "отказ backup.sh не оставляет файлов"
if DATABASE_URL="$PG_URL/${prefix}nonexistent" BACKUP_DIR="$work/failed" BACKUP_PASSPHRASE="$pass" \
     ./scripts/backup.sh > "$work/failed.log" 2>&1; then
  bad "снимок несуществующей базы «удался»" "$work/failed.log"
else
  ok "снимок несуществующей базы: отказ"
fi
left="$(find "$work/failed" -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$left" = "0" ]; then ok "ни копии, ни .part не осталось"; else bad "осталось файлов: $left"; fi
if BACKUP_DIR="$work/failed" DATABASE_URL="$SRC_URL" ./scripts/backup.sh > "$work/nopass.log" 2>&1; then
  bad "без BACKUP_PASSPHRASE снимок сделан" "$work/nopass.log"
else
  ok "без BACKUP_PASSPHRASE: отказ"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "проверка восстановимости (verify-backup.sh) на исправной копии"
n_verify_before="$(psql "$PG_BASE/postgres" -XtAc "select count(*) from pg_database where starts_with(datname, 'quizzy_verify_')")"
# Рядом с копией — более свежие недописанный снимок (.part) и снимок перед
# обновлением чужого экземпляра: проверка не должна брать ни тот, ни другой.
sleep 1
printf 'обрыв' > "$(dirname "$copy")/quizzy_9999-99-99_999999.dump.zst.gpg.part"
mkdir -p "$work/backups/upgrade/other"
printf 'чужой' > "$work/backups/upgrade/other/quizzy_9999-99-99_999999.dump.zst.gpg"
# APP_EXEC пустой — пересчёт журнала bun'ом из этой рабочей копии, а не
# образом api (его здесь нет).
if APP_EXEC="" DATABASE_URL="$SRC_URL" BACKUP_DIR="$work/backups" BACKUP_PASSPHRASE="$pass" \
     ./scripts/verify-backup.sh > "$work/verify.log" 2>&1; then
  ok "verify-backup.sh: копия пригодна"
else
  bad "verify-backup.sh забраковал исправную копию" "$work/verify.log"
fi
if grep -q 'пересчитана кодом приложения' "$work/verify.log" && grep -q 'записей: 6' "$work/verify.log"; then
  ok "журнал пересчитан кодом приложения: 6 записей"
else
  bad "в выводе нет пересчёта журнала" "$work/verify.log"
fi
no_leak "$work/verify.log" "verify-backup.sh"
n_verify_after="$(psql "$PG_BASE/postgres" -XtAc "select count(*) from pg_database where starts_with(datname, 'quizzy_verify_')")"
if [ "$n_verify_before" = "$n_verify_after" ]; then ok "одноразовая база проверки удалена"; else bad "после проверки осталась база quizzy_verify_*"; fi

# ─────────────────────────────────────────────────────────────────────────────
section "подменённая запись журнала при сохранённых хэшах"
newdb tam
TAM_URL="$PG_URL/${prefix}tam"
DATABASE_URL="$TAM_URL" BACKUP_PASSPHRASE="$pass" ./scripts/restore.sh "$copy" > "$work/tam-restore.log" 2>&1 \
  || { bad "не удалось развернуть копию для подмены" "$work/tam-restore.log"; }
# Меняется поле верхнего уровня details: его хэш покрывает при любой
# канонизации, прежней и новой. Триггер неизменяемости выключается только в
# этой одноразовой базе — ровно то, что сделал бы тот, кто правит копию.
psql "$TAM_URL" -Xq -v ON_ERROR_STOP=1 -c "
  alter table audit_log disable trigger audit_log_immutable;
  update audit_log set details = jsonb_set(details, '{note}', '\"підмінено\"') where seq = 3;
  alter table audit_log enable trigger audit_log_immutable;"
old_check="$(psql "$TAM_URL" -XtAc "
  with chained as (select seq, prev_hash, lag(entry_hash) over (order by seq) as expected from audit_log)
  select count(*) from chained where seq > 1 and prev_hash is distinct from expected")"
if [ "$old_check" = "0" ]; then ok "прежняя сверка соседних хэшей подмену не видит (разрывов: 0) — сценарий осмыслен"; else bad "подмена задела хэши — сценарий проверяет не то"; fi
if DATABASE_URL="$TAM_URL" BACKUP_DIR="$work/tampered" BACKUP_PASSPHRASE="$pass" \
     ./scripts/backup.sh > "$work/tam-backup.log" 2>&1; then
  ok "копия подменённой базы снята"
else
  bad "не удалось снять копию подменённой базы" "$work/tam-backup.log"
fi
# Сверяется с НЕТРОНУТОЙ исходной: число строк и последний хэш совпадают, и
# поймать подмену может только пересчёт.
if APP_EXEC="" DATABASE_URL="$SRC_URL" BACKUP_DIR="$work/tampered" BACKUP_PASSPHRASE="$pass" \
     ./scripts/verify-backup.sh > "$work/tam-verify.log" 2>&1; then
  bad "verify-backup.sh пропустил подменённую запись" "$work/tam-verify.log"
elif grep -q 'цепочка журнала не сходится' "$work/tam-verify.log" && grep -q 'записи 3' "$work/tam-verify.log"; then
  ok "verify-backup.sh поймал подмену и назвал запись №3"
else
  bad "verify-backup.sh упал, но не на цепочке журнала" "$work/tam-verify.log"
fi
no_leak "$work/tam-verify.log" "verify-backup.sh (провал)"

# ─────────────────────────────────────────────────────────────────────────────
section "снимок перед обновлением (upgrade-instances.sh)"
# bun подменён заглушкой: здесь проверяется снимок, а не миграции. Заглушка
# ещё и читает стандартный вход до конца — как любая программа в цикле,
# которая его читает (docker exec): список экземпляров не должен от этого
# кончаться после первого.
mkdir -p "$work/stubbin"
printf '#!/bin/sh\necho "bun $*" >> "%s/bun-calls"\ncat > /dev/null\nexit 0\n' "$work" > "$work/stubbin/bun"
chmod +x "$work/stubbin/bun"
printf 'bk_one  %s\n# комментарий\nbk_two  %s\n' "$SRC_URL" "$SRC_URL" > "$work/instances.txt"

if PATH="$work/stubbin:$PATH" INSTANCES="$work/instances.txt" BACKUP_DIR="$work/upg" \
     ./scripts/upgrade-instances.sh < /dev/null > "$work/upg-nopass.log" 2>&1; then
  bad "обновление без BACKUP_PASSPHRASE запустилось" "$work/upg-nopass.log"
elif [ ! -e "$work/bun-calls" ] && [ -z "$(find "$work/upg" -type f 2>/dev/null)" ]; then
  ok "без BACKUP_PASSPHRASE: отказ до первого экземпляра"
else
  bad "без BACKUP_PASSPHRASE что-то успело выполниться" "$work/upg-nopass.log"
fi

if PATH="$work/stubbin:$PATH" INSTANCES="$work/instances.txt" BACKUP_DIR="$work/upg" BACKUP_PASSPHRASE="$pass" \
     ./scripts/upgrade-instances.sh < /dev/null > "$work/upg.log" 2>&1; then
  ok "upgrade-instances.sh завершился успешно"
else
  bad "upgrade-instances.sh упал" "$work/upg.log"
fi
if grep -q 'Обновлено: 2 из 2' "$work/upg.log"; then ok "обработаны оба экземпляра списка"; else bad "обработаны не все экземпляры" "$work/upg.log"; fi
snap="$(find "$work/upg/upgrade/bk_one" -type f -name 'quizzy_*.dump.zst.gpg' 2>/dev/null | head -1 || true)"
snap2="$(find "$work/upg/upgrade/bk_two" -type f -name 'quizzy_*.dump.zst.gpg' 2>/dev/null | head -1 || true)"
plain="$(find "$work/upg" -type f ! -name '*.gpg' 2>/dev/null | wc -l | tr -d ' ' || true)"
if [ -n "$snap" ] && [ -n "$snap2" ] && [ "$plain" = "0" ]; then ok "снимки — .gpg в upgrade/<имя>/, открытых файлов нет"; else bad "снимков .gpg нет или рядом открытые файлы ($plain)" "$work/upg.log"; fi
if [ -n "$snap" ] && [ "$(mode "$snap")" = "600" ]; then ok "права снимка 600"; else bad "права снимка $(mode "$snap" 2>/dev/null)"; fi
newdb upg
UPG_URL="$PG_URL/${prefix}upg"
if [ -n "$snap" ] && DATABASE_URL="$UPG_URL" BACKUP_PASSPHRASE="$pass" ./scripts/restore.sh "$snap" > "$work/upg-restore.log" 2>&1 \
   && [ "$(fingerprint "$UPG_URL")" = "$fp_src" ]; then
  ok "снимок перед обновлением восстанавливается и совпадает с исходной"
else
  bad "снимок перед обновлением не восстановился или отличается" "$work/upg-restore.log"
fi
no_leak "$work/upg.log" "upgrade-instances.sh"

# ─────────────────────────────────────────────────────────────────────────────
section "снимок перед выкаткой (BACKUP_KIND=predeploy) не трогает ротацию"
# Выкатка запускала службу копий без метки, и каждый её снимок становился
# суточной копией — в воскресенье недельной, 1-го числа месячной, — а
# ротация по количеству вытесняла им копии прошлых дней (#156). Часы здесь
# подменены на воскресенье 1-го числа: худший день, когда копия без метки
# уходит в monthly и вытесняет там старейшую. Каталоги расписания заполнены
# до предела (7/4/12), в predeploy/ — 9 прежних снимков: после трёх выкаток
# их 12, и срок хранения (10) обязан сработать в своём каталоге и только в
# нём.
real_date="$(command -v date)"
mkdir -p "$work/datebin"
# shellcheck disable=SC2016 # $1 и $@ — для заглушки, а не для этой оболочки
printf '#!/bin/sh\ncase "$1" in\n  +%%u) echo 7 ;;\n  +%%d) echo 01 ;;\n  *) exec "%s" "$@" ;;\nesac\n' "$real_date" > "$work/datebin/date"
chmod +x "$work/datebin/date"
pd="$work/pd"
seed() { # каталог сколько
  mkdir -p "$pd/$1"
  for i in $(seq 1 "$2"); do
    f="$pd/$1/quizzy_2026-01-$(printf '%02d' "$i")_030000.dump.zst.gpg"
    printf 'прежняя копия %s %s' "$1" "$i" > "$f"
    touch -t "202601$(printf '%02d' "$i")0300" "$f"
  done
}
seed daily 7; seed weekly 4; seed monthly 12; seed predeploy 9
sched() { (cd "$pd" && find daily weekly monthly -type f -exec cksum {} + | sort); }
sched_before="$(sched)"

pd_failed=0
real_snaps=""
for i in 1 2 3; do
  # имя снимка — с точностью до секунды
  sleep 1
  if PATH="$work/datebin:$PATH" DATABASE_URL="$SRC_URL" BACKUP_DIR="$pd" BACKUP_PASSPHRASE="$pass" BACKUP_KIND=predeploy \
       ./scripts/backup.sh > "$work/pd-$i.log" 2>&1 && grep -q 'объектов в архиве: [1-9]' "$work/pd-$i.log"; then
    real_snaps="$real_snaps $(sed -n 's/^бэкап: \([^ ]*\) .*/\1/p' "$work/pd-$i.log")"
  else
    pd_failed=$((pd_failed + 1)); bad "снимок выкатки №$i не снят или не прочитан обратно" "$work/pd-$i.log"
  fi
done
[ "$pd_failed" = "0" ] && ok "три снимка выкатки сняты и прочитаны обратно"
if [ "$(sched)" = "$sched_before" ]; then
  ok "daily/weekly/monthly после трёх выкаток в воскресенье 1-го — те же файлы, байт в байт (7/4/12)"
else
  bad "снимки выкатки задели копии по расписанию"
  diff <(printf '%s\n' "$sched_before") <(sched) | head -n 10 | sed 's/^/      | /' || true
fi
n_pd="$(find "$pd/predeploy" -type f | wc -l | tr -d ' ')"
kept=1
for f in $real_snaps; do case "$f" in "$pd/predeploy/"*) [ -f "$f" ] || kept=0 ;; *) kept=0 ;; esac; done
if [ "$n_pd" = "10" ] && [ "$kept" = "1" ] && [ -n "$real_snaps" ] \
   && [ ! -e "$pd/predeploy/quizzy_2026-01-01_030000.dump.zst.gpg" ] \
   && [ ! -e "$pd/predeploy/quizzy_2026-01-02_030000.dump.zst.gpg" ] \
   && [ -e "$pd/predeploy/quizzy_2026-01-03_030000.dump.zst.gpg" ]; then
  ok "в predeploy/ — 10 последних: три новых на месте, два старейших прежних убраны"
else
  bad "срок хранения predeploy/ не тот: файлов $n_pd, новые на месте: $kept"
fi
for i in 1 2 3; do no_leak "$work/pd-$i.log" "снимок выкатки №$i"; done
# Контроль: та же проверка видит ротацию, когда она есть. Копия без метки в
# тот же «день» уходит в monthly и вытесняет старейшую месячную.
sleep 1
PATH="$work/datebin:$PATH" DATABASE_URL="$SRC_URL" BACKUP_DIR="$pd" BACKUP_PASSPHRASE="$pass" \
  ./scripts/backup.sh > "$work/pd-sched.log" 2>&1 || true
if [ "$(sched)" != "$sched_before" ] && [ ! -e "$pd/monthly/quizzy_2026-01-01_030000.dump.zst.gpg" ] \
   && [ "$(find "$pd/monthly" -type f | wc -l | tr -d ' ')" = "12" ]; then
  ok "контроль: копия без метки ушла в monthly и вытеснила старейшую — сверка выше ловит ротацию"
else
  bad "контроль не сработал: копия без метки не задела monthly — сверка выше ничего не доказывает" "$work/pd-sched.log"
fi

# ─────────────────────────────────────────────────────────────────────────────
section "временные файлы"
if [ -z "$(ls -A "$work/tmp")" ]; then ok "во временном каталоге скриптов пусто"; else bad "во временном каталоге остались файлы: $(ls -A "$work/tmp" | head -3 | tr '\n' ' ')"; fi

finish
