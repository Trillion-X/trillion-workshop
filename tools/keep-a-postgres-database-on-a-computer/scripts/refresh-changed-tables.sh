# Reloads only the named tables of a copy from the old database, so a cutover's pause carries the rows written since the first
# copy without copying a large table that did not change (workflow:move-a-pursuits-databases-onto-another-server,
# copy-again-or-keep). It runs as the database server's own account over its unix socket, on the copy's server, and reads the
# old database through the held connection $SECRET_NAME (its own login, over TLS: set PGSSLROOTCERT=system), which only reads.
# REFRESH_TABLES names the tables (schema.table, spaces between); each must already exist in the copy, whose objects compare
# equal to the old database's, since only rows are carried. In one transaction, with session_replication_role=replica so
# foreign keys and triggers do not fire on rows that already passed them in the old database, it deletes every row of each
# named table in TO_DATABASE and writes the old database's rows (pg_dump --data-only, the tables' own sequences set by the
# dump); a failure leaves the copy as it was. The old database is never written.
set -eu
[ -n "${TO_DATABASE:-}" ] && [ -n "${REFRESH_TABLES:-}" ] || { echo "Needs TO_DATABASE and REFRESH_TABLES." >&2; exit 2; }
url=$(cat "$CREDENTIALS_DIRECTORY/$SECRET_NAME")
missing=
for t in $REFRESH_TABLES; do
  [ "$(psql -X -At -d "$TO_DATABASE" -c "select to_regclass('$t') is not null")" = t ] || missing="$missing $t"
done
[ -z "$missing" ] || { echo "Not in $TO_DATABASE:$missing; copy the database first." >&2; exit 2; }
args=
for t in $REFRESH_TABLES; do args="$args --table=$t"; done
{
  echo "SET session_replication_role = replica;"
  for t in $REFRESH_TABLES; do echo "DELETE FROM $t;"; done
  # shellcheck disable=SC2086
  # A pg_dump that stops part way would hand psql a part of the rows, and a pipe hides its exit status: on failure it writes a
  # statement that fails, so ON_ERROR_STOP rolls the whole transaction back, the DELETEs with it.
  pg_dump --data-only --no-owner --no-privileges $args "$url" || echo "SELECT the_old_database_could_not_be_read;"
} | psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$TO_DATABASE"
echo "refreshed $(echo $REFRESH_TABLES | wc -w | tr -d ' ') tables of $TO_DATABASE from the old database"
