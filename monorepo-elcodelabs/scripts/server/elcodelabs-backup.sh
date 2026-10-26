#!/usr/bin/env bash
# elcodelabs-backup — nightly dump of every app database on this server, rotated.
#
# Installed ONCE PER SERVER, not per app (references/docker-deployment.md › Backups):
#   /opt/elcodelabs/backup.sh               this file
#   /etc/systemd/system/elcodelabs-backup.{service,timer}
#   /etc/elcodelabs/backup.env              settings, chmod 600 (backup.env.example)
# Every database whose name ends in _db (one per app: <slug>_db) is included, so a new app is
# backed up from its first night without touching this script.
#
# Per database it keeps 5 daily, 2 weekly (Sunday), and 1 monthly (the 1st) dump — 8 files at
# most. Weekly and monthly ones are hard links to a daily file: they take no extra space.
# It refuses to write when the disk is low, checks every dump, test-restores the newest one on
# the 1st of each month, and reports failures (and a weekly "all fine") to Telegram.
set -uo pipefail
umask 077

[ -f /etc/elcodelabs/backup.env ] && . /etc/elcodelabs/backup.env
ROOT="${BACKUP_ROOT:-/var/backups/elcodelabs}"
KEEP_DAILY="${KEEP_DAILY:-5}"
KEEP_WEEKLY="${KEEP_WEEKLY:-2}"
KEEP_MONTHLY="${KEEP_MONTHLY:-1}"
MIN_FREE_PCT="${MIN_FREE_PCT:-15}"
DB_PATTERN="${DB_PATTERN:-_db$}"
# MySQL's root through auth_socket: the unit runs as root.
MYSQL="${MYSQL:-mysql}"
MYSQLDUMP="${MYSQLDUMP:-mysqldump}"

notify() {
  echo "$1"
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ]; then
    curl -s -m 15 -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" --data-urlencode text="[$(hostname)] $1" || echo "  (Telegram unreachable)"
  fi
}

# prune <dir> <keep>: drop all but the newest <keep> dumps in dir.
prune() {
  ls -1t "$1"/*.sql.gz 2>/dev/null | tail -n +$(( $2 + 1 )) | xargs -r rm -f
}

# restore_test <db> <dump>: load the dump into a scratch database and compare table counts.
restore_test() {
  local db="$1" dump="$2" scratch="${1}_restoretest" want got
  $MYSQL -e "DROP DATABASE IF EXISTS \`$scratch\`; CREATE DATABASE \`$scratch\`" || return 1
  if ! gunzip -c "$dump" | $MYSQL "$scratch"; then
    $MYSQL -e "DROP DATABASE IF EXISTS \`$scratch\`"
    return 1
  fi
  want="$($MYSQL -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$db'")"
  got="$($MYSQL -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$scratch'")"
  $MYSQL -e "DROP DATABASE IF EXISTS \`$scratch\`"
  [ "$want" = "$got" ]
}

mkdir -p "$ROOT"
free=$(( 100 - $(df -P "$ROOT" | awk 'NR==2 { sub("%", "", $5); print $5 }') ))
if [ "$free" -lt "$MIN_FREE_PCT" ]; then
  notify "Backup DIBATALKAN: disk tinggal ${free}% (batas ${MIN_FREE_PCT}%). Kosongkan disk — MySQL berhenti jika disk penuh."
  exit 1
fi

today="$(date +%F)"
dow="$(date +%u)"
dom="$(date +%d)"
failed=()
count=0
for db in $($MYSQL -N -e 'SHOW DATABASES' | grep -E "$DB_PATTERN"); do
  dir="$ROOT/$db"
  mkdir -p "$dir/daily" "$dir/weekly" "$dir/monthly"
  f="$dir/daily/$db-$today.sql.gz"
  if $MYSQLDUMP --single-transaction --routines --triggers --events --hex-blob \
      --default-character-set=utf8mb4 --set-gtid-purged=OFF --no-tablespaces "$db" | gzip -9 > "$f.tmp" \
    && gzip -t "$f.tmp" && [ "$(stat -c %s "$f.tmp")" -gt 100 ]; then
    mv -f "$f.tmp" "$f"
  else
    rm -f "$f.tmp"
    failed+=("$db")
    continue
  fi
  [ "$dow" = 7 ] && ln -f "$f" "$dir/weekly/"
  [ "$dom" = 01 ] && ln -f "$f" "$dir/monthly/"
  prune "$dir/daily" "$KEEP_DAILY"
  prune "$dir/weekly" "$KEEP_WEEKLY"
  prune "$dir/monthly" "$KEEP_MONTHLY"
  if [ "$dom" = 01 ] && ! restore_test "$db" "$f"; then
    failed+=("$db (uji restore)")
  fi
  count=$(( count + 1 ))
done

if [ "${#failed[@]}" -gt 0 ]; then
  notify "Backup GAGAL untuk: ${failed[*]}. Periksa: journalctl -u elcodelabs-backup"
  exit 1
fi
if [ "$dow" = 7 ]; then
  notify "Backup mingguan OK: ${count} database, disk ${free}% kosong."
fi
echo "ok: ${count} database(s), ${free}% disk free"
