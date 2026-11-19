# Copies one database's public schema (tables, rows, views, functions, triggers, sequences, comments) into a new, empty
# database, so the new one can take the old one's place with nothing lost. It runs as the database server's own account, over
# the server's unix socket (peer authentication), and reads the new database's connection string,
# postgresql://ROLE:PASSWORD@HOST/DATABASE, from the sealed credential $SECRET_NAME: everything copied is made as ROLE, so the
# new database's own login owns it. The old database is only read, and is never changed or dropped.
#
# FROM_DATABASE names the old database. TABLES_LEFT_OUT (names, spaces between) are tables not copied, such as a sign-in tool's
# own tables that go to a store of their own; TABLES_ONLY (names, spaces between) copies only those tables. The copy refuses a
# new database that already has a table in public, so a second run never writes over rows, and runs as one transaction, so a
# failed copy leaves the new database empty.
set -eu
url=$(cat "$CREDENTIALS_DIRECTORY/$SECRET_NAME")
rest=${url#*://}
login=${rest%%@*}
TO_ROLE=${login%%:*}
database=${rest#*@}
database=${database#*/}
TO_DATABASE=${database%%\?*}
[ -n "$TO_ROLE" ] && [ -n "$TO_DATABASE" ] && [ -n "${FROM_DATABASE:-}" ] || { echo "Needs FROM_DATABASE and a held postgresql://ROLE:PASSWORD@HOST/DATABASE." >&2; exit 2; }
[ "$TO_DATABASE" != "$FROM_DATABASE" ] || { echo "The new database is the old one." >&2; exit 2; }
has=$(psql -X -At -d "$TO_DATABASE" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
if [ "$has" != "0" ]; then echo "$TO_DATABASE already has $has tables in public; nothing copied."; exit 0; fi
set --
for table in ${TABLES_ONLY:-}; do set -- "$@" --table="public.\"$table\""; done
for table in ${TABLES_LEFT_OUT:-}; do set -- "$@" --exclude-table="public.\"$table\""; done
dump=$(mktemp)
pg_dump --dbname="$FROM_DATABASE" --schema=public --no-owner --no-privileges --no-publications --no-subscriptions "$@" > "$dump"
grep -v -x -e 'CREATE SCHEMA public;' -e 'COMMENT ON SCHEMA public IS .*' "$dump" \
  | PGOPTIONS="-c role=$TO_ROLE" psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$TO_DATABASE"
echo "copied $FROM_DATABASE into $TO_DATABASE as $TO_ROLE: $(psql -X -At -d "$TO_DATABASE" -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'") tables"
