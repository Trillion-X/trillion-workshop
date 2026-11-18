# Proves the newest backup restores every database the server holds: the live server switches to its next WAL segment and
# waits until the archive holds it, and its list of databases is taken then; WAL-G fetches the newest backup into a private
# scratch folder, a second server (no network listener, its own socket folder) starts from it and replays the archived WAL,
# and every database on that list must be there and open. The scratch folder is the unit's private /tmp, which systemd
# removes when the run ends. The store's address and key are the NAME=value lines of the sealed credential $SECRET_NAME.
# Exit 0 only when the restored server holds and opens every database the live one held, so a database made since the last
# base backup is proved by its WAL, and one no row names is proved too.
set -eu
set -a
. "$CREDENTIALS_DIRECTORY/$SECRET_NAME"
set +a
list="SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1"
# The segment that holds the last byte written before the switch (when nothing was written since the last switch, the switch
# is a no-op and that is the segment already archived).
last=$(psql -X -At -d postgres -c "SELECT pg_walfile_name(pg_switch_wal() - 1)")
for _ in $(seq 1 300); do
  [ "$(psql -X -At -d postgres -c "SELECT coalesce(last_archived_wal >= '$last', false) FROM pg_stat_archiver")" = t ] && break
  sleep 1
done
[ "$(psql -X -At -d postgres -c "SELECT coalesce(last_archived_wal >= '$last', false) FROM pg_stat_archiver")" = t ] || { echo "The archive did not reach $last within 300 s." >&2; exit 1; }
live=$(psql -X -At -d postgres -c "$list")
scratch=$(mktemp -d)
wal-g backup-fetch "$scratch/data" LATEST
touch "$scratch/data/recovery.signal"
pg_ctl -D "$scratch/data" -w -t 900 -o "-c listen_addresses= -c unix_socket_directories=$scratch -c archive_mode=off -c restore_command='wal-g wal-fetch %f %p'" start
trap 'pg_ctl -D "$scratch/data" -m fast stop' EXIT
psql -X -At -h "$scratch" -d postgres -c "$list" > "$scratch/restored"
missing=$(printf '%s\n' "$live" | grep -vxF -f "$scratch/restored" || true)
[ -z "$missing" ] || { echo "The restored server does not hold: $(echo $missing)." >&2; exit 1; }
for database in $live; do
  psql -X -At -h "$scratch" -d "$database" -c "SELECT count(*) FROM pg_class" >/dev/null || { echo "The restored database $database does not open." >&2; exit 1; }
done
echo "restored the newest backup and opened all $(printf '%s\n' "$live" | wc -l) databases"
