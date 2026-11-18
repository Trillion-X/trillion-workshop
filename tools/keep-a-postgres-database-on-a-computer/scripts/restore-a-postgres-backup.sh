# Proves the newest backup restores: WAL-G fetches it into a private scratch folder, a second server (no network listener,
# its own socket folder) starts from it and replays the archived WAL, and the database the row names must be there. The
# scratch folder is the unit's private /tmp, which systemd removes when the run ends. The store's address and key are the
# NAME=value lines of the sealed credential $SECRET_NAME. Exit 0 only when the restored server holds PG_DATABASE.
set -eu
set -a
. "$CREDENTIALS_DIRECTORY/$SECRET_NAME"
set +a
scratch=$(mktemp -d)
wal-g backup-fetch "$scratch/data" LATEST
touch "$scratch/data/recovery.signal"
pg_ctl -D "$scratch/data" -w -t 900 -o "-c listen_addresses= -c unix_socket_directories=$scratch -c archive_mode=off -c restore_command='wal-g wal-fetch %f %p'" start
trap 'pg_ctl -D "$scratch/data" -m fast stop' EXIT
found=$(psql -X -At -h "$scratch" -d postgres -c "SELECT count(*) FROM pg_database WHERE datname = '$PG_DATABASE'")
[ "$found" = 1 ] || { echo "The restored server does not hold the database $PG_DATABASE." >&2; exit 1; }
echo "restored the newest backup and found $PG_DATABASE"
