# One base backup of the database server's data folder to the backup store, by WAL-G, then a switch to the next WAL segment
# and a wait until the archive holds every segment up to it, so the backup that just finished restores without a later one.
# The store's address and key are the NAME=value lines of the sealed credential $SECRET_NAME; the server's own continuous
# WAL archive uses the same ones.
set -eu
set -a
. "$CREDENTIALS_DIRECTORY/$SECRET_NAME"
set +a
wal-g backup-push "$PGDATA"
last=$(psql -X -At -d postgres -c "SELECT pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 300); do
  [ "$(psql -X -At -d postgres -c "SELECT coalesce(last_archived_wal >= '$last', false) FROM pg_stat_archiver")" = t ] && exit 0
  sleep 1
done
echo "The archive did not reach $last within 300 s." >&2
exit 1
