#!/usr/bin/env bash
# Внешняя копия резервных копий: S3-совместимое хранилище у другого
# поставщика (Backblaze B2, Cloudflare R2, любое с подписью SigV4).
#
#   offsite.sh put <файл> [<файл>…]   положить файлы (ключ — kind/имя)
#   offsite.sh list                    что лежит снаружи
#   offsite.sh check                   каждая местная копия есть снаружи
#                                      и того же размера; код 1, если нет
#
# Окружение (то же, что у backup.sh, — EnvironmentFile службы):
#   OFFSITE_URL     адрес корзины, например
#                   https://<account>.r2.cloudflarestorage.com/<bucket>
#                   https://s3.<region>.backblazeb2.com/<bucket>
#   OFFSITE_KEY_ID, OFFSITE_SECRET   ключ доступа к корзине (только к ней)
#   OFFSITE_REGION  область подписи: у R2 — «auto», у B2 — из адреса
#                   (us-west-004 и т. п.); пусто — «auto»
#   BACKUP_DIR      для check: откуда брать местные копии
#
# Пусто OFFSITE_URL — внешней копии нет: put и check молча выходят нулём,
# чтобы backup.sh и проверка работали на установках без неё. Так на
# сервере не появляется второго пути для копий, который «настроят потом».
#
# Зачем это есть. Копии шифруются и проверяются чтением, но лежат на том
# же VPS, что и база: отказ диска, снос сервера или потеря учётной записи
# у поставщика уносят и данные, и все копии разом. Внешняя копия — у
# другого поставщика, на другом ключе. Содержимое уходит уже
# зашифрованным (gpg, фраза BACKUP_PASSPHRASE), хранилище видит только
# шифротекст.
#
# Только curl. На сервере нет rclone, aws и restic, и ставить их ради
# одного PUT незачем: curl с 7.75 подписывает запросы S3 сам
# (--aws-sigv4). Докачки по частям нет — копии весят десятки мегабайт.
#
# Ротация снаружи — правилом хранения самой корзины (lifecycle: удалять
# объекты старше N дней), а не этим скриптом: удалять снаружи с того же
# ключа, которым пишут, значило бы, что утёкший ключ стирает и внешнюю
# копию. Ключу достаточно прав на запись и чтение; см. docs/DEPLOY.md.
set -euo pipefail

cmd="${1:-}"
[ -n "$cmd" ] || { sed -n '2,9p' "$0" >&2; exit 2; }
shift

if [ -z "${OFFSITE_URL:-}" ]; then
  case "$cmd" in
    put|check) echo "внешняя копия не настроена (OFFSITE_URL пуст) — пропуск"; exit 0 ;;
    *) echo "OFFSITE_URL пуст" >&2; exit 2 ;;
  esac
fi
: "${OFFSITE_KEY_ID:?OFFSITE_KEY_ID обязателен при OFFSITE_URL}"
: "${OFFSITE_SECRET:?OFFSITE_SECRET обязателен при OFFSITE_URL}"
region="${OFFSITE_REGION:-auto}"
base="${OFFSITE_URL%/}"

# Ключ и секрет — через конфиг на дескрипторе, не аргументом: аргументы
# видны в ps любому пользователю хоста всё время запроса.
s3() {
  curl --silent --show-error --fail-with-body --max-time 600 \
    --aws-sigv4 "aws:amz:$region:s3" --config /dev/fd/3 "$@" \
    3<<<"user = \"$OFFSITE_KEY_ID:$OFFSITE_SECRET\""
}

# Ключ объекта — подкаталог ротации и имя: daily/quizzy_….dump.zst.gpg
key_of() {
  local f="$1" kind
  kind="$(basename "$(dirname "$f")")"
  printf '%s/%s' "$kind" "$(basename "$f")"
}

# Размер снаружи по HEAD; пусто — объекта нет
remote_size() {
  s3 --head "$base/$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{print $2}'
}

put_one() {
  local f="$1" key size
  [ -f "$f" ] || { echo "нет файла: $f" >&2; return 1; }
  key="$(key_of "$f")"
  size="$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")"
  s3 --upload-file "$f" --header "Content-Type: application/octet-stream" "$base/$key" >/dev/null
  # что положили, то и лежит: размер по HEAD после загрузки
  local got; got="$(remote_size "$key")"
  if [ "$got" != "$size" ]; then
    echo "ОТКАЗ: $key снаружи ${got:-нет}, а местный $size байт" >&2
    return 1
  fi
  echo "внешняя копия: $key ($size байт)"
}

list_remote() {
  # ListObjectsV2, одна страница на 1000 объектов — копий меньше трёх десятков
  s3 "$base/?list-type=2" \
    | tr -d '\n' | sed 's/<Contents>/\n<Contents>/g' \
    | sed -n 's/.*<Key>\([^<]*\)<\/Key>.*<Size>\([0-9]*\)<\/Size>.*/\2 \1/p'
}

case "$cmd" in
  put)
    [ $# -gt 0 ] || { echo "put: укажите файлы" >&2; exit 2; }
    rc=0
    for f in "$@"; do put_one "$f" || rc=1; done
    exit $rc ;;
  list)
    list_remote | sort -k2 ;;
  check)
    : "${BACKUP_DIR:?BACKUP_DIR обязателен для check}"
    remote="$(list_remote)"
    missing=0; total=0
    for kind in daily weekly monthly; do
      for f in "$BACKUP_DIR/$kind"/*.dump.zst.gpg; do
        [ -f "$f" ] || continue
        total=$((total + 1))
        key="$(key_of "$f")"
        size="$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f")"
        if ! printf '%s\n' "$remote" | grep -qx "$size $key"; then
          echo "нет снаружи или другой размер: $key ($size байт)"
          missing=$((missing + 1))
        fi
      done
    done
    echo "внешняя копия: местных $total, расходятся $missing, снаружи всего $(printf '%s\n' "$remote" | grep -c . || true)"
    [ "$missing" = 0 ] ;;
  *) echo "неизвестная команда: $cmd" >&2; exit 2 ;;
esac
