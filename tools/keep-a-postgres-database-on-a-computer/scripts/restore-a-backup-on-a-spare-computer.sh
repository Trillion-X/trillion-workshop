# Restores the backup store's newest backup on a spare computer that runs no database of its own, and counts every table's rows,
# so a drill can compare the copy with the live store. WAL-G fetches the newest backup into the unit's private scratch folder; a
# server with no network listener (its own socket folder) starts from it, replays the archived WAL up to RECOVERY_TARGET_LSN
# when the unit's environment names one (else to the end of the archive), and is promoted, archiving nothing. The store's
# address and key are the NAME=value lines of the sealed credential $SECRET_NAME. It prints one JSON line per database it opens
# ({"database", "tables": {"schema.table": rows}}) and one line of times ({"backup", "fetch_s", "replay_s", "recovered_to"}),
# and exits 0 only when every database the restored server holds opens.
set -eu
set -a
. "$CREDENTIALS_DIRECTORY/$SECRET_NAME"
set +a
scratch=$(mktemp -d)
began=$(date +%s)
backup=$(wal-g backup-list 2>/dev/null | awk 'NR > 1 { name = $1 } END { print name }')
[ -n "$backup" ] || { echo "The backup store lists no backup." >&2; exit 1; }
wal-g backup-fetch "$scratch/data" "$backup"
fetched=$(date +%s)
touch "$scratch/data/recovery.signal"
target=
[ -z "${RECOVERY_TARGET_LSN:-}" ] || target="-c recovery_target_lsn=$RECOVERY_TARGET_LSN -c recovery_target_action=promote"
pg_ctl -D "$scratch/data" -w -t 1800 -o "-c listen_addresses= -c unix_socket_directories=$scratch -c archive_mode=off -c restore_command='wal-g wal-fetch %f %p' $target" start
trap 'pg_ctl -D "$scratch/data" -m fast stop' EXIT
for _ in $(seq 1 1800); do
  [ "$(psql -X -At -h "$scratch" -d postgres -c 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ] && break
  sleep 1
done
[ "$(psql -X -At -h "$scratch" -d postgres -c 'SELECT pg_is_in_recovery()')" = f ] || { echo "The restored server was still replaying WAL after 1800 s." >&2; exit 1; }
replayed=$(date +%s)
recovered_to=$(psql -X -At -h "$scratch" -d postgres -c "SELECT pg_last_wal_replay_lsn()")
count="SELECT json_build_object('database', current_database(), 'tables', coalesce(json_object_agg(t.name, t.rows ORDER BY t.name), '{}'::json)) FROM (SELECT table_schema || '.' || table_name AS name, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text::bigint AS rows FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')) t"
for database in $(psql -X -At -h "$scratch" -d postgres -c "SELECT datname FROM pg_database WHERE datallowconn ORDER BY 1"); do
  psql -X -At -h "$scratch" -d "$database" -c "$count" || { echo "The restored database $database does not open." >&2; exit 1; }
done
printf '{"backup": "%s", "fetch_s": %s, "replay_s": %s, "recovered_to": "%s"}\n' "$backup" $((fetched - began)) $((replayed - fetched)) "$recovered_to"
