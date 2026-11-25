# Copies one database's public schema, or every schema (tables, rows, views, functions, triggers, sequences, comments) into a new, empty
# database, so the new one can take the old one's place with nothing lost. It runs as the database server's own account, over
# the server's unix socket (peer authentication), and reads the new database's connection string,
# postgresql://ROLE:PASSWORD@HOST/DATABASE, from the sealed credential $SECRET_NAME: everything copied is made as ROLE, so the
# new database's own login owns it. The old database is only read, and is never changed or dropped.
#
# FROM_DATABASE names the old database. TABLES_LEFT_OUT (names, spaces between) are tables not copied, such as a sign-in tool's
# own tables that go to a store of their own; TABLES_ONLY (names, spaces between) copies only those tables. SCHEMAS=all copies
# every schema of the old database (its own schemas, and the extensions it uses, which the new server must already offer), not
# only public. TO_THROUGH_CONNECTION=yes writes through the held connection itself, to its host over TLS as its own login (set
# PGSSLROOTCERT=system for its verify-full), so the new database may be on another server; else it is on this server and is
# written over the socket. The copy refuses a new database that already has a table (in public, or in any schema with
# SCHEMAS=all), so a second run never writes over rows, and runs as one transaction, so a failed copy leaves it empty.
# FROM_THROUGH_CONNECTION=yes turns it round: the held connection opens the old database (over TLS, as its own login, which
# only reads), and the new one is TO_DATABASE on this server, written over the socket as TO_ROLE, so the copy runs on the new
# database's server and its server needs no port open to the old one. A login reads no row a forced row-security policy hides
# from it (FORCE ROW LEVEL SECURITY binds a table's owner too), so such a database is copied through the backup store instead:
# TO_STORE=NAME, on the old database's server, dumps FROM_DATABASE as the server's own account (which every row is open to)
# and puts the dump in the store under NAME, writing no database; FROM_STORE=NAME, on the new database's server, takes that
# dump from the store and writes it into TO_DATABASE as TO_ROLE over the socket, with the same refusal and one transaction.
# In those two the sealed credential $SECRET_NAME is the store's settings and key (NAME=value lines, WAL-G's own), not a
# connection string, and nothing on either server opens a port to the other.
set -eu
if [ -n "${TO_STORE:-}${FROM_STORE:-}" ]; then
  set -a; . "$CREDENTIALS_DIRECTORY/$SECRET_NAME"; set +a
  url=
else
  url=$(cat "$CREDENTIALS_DIRECTORY/$SECRET_NAME")
fi
rest=${url#*://}
login=${rest%%@*}
database=${rest#*@}
database=${database#*/}
if [ -n "${TO_STORE:-}" ]; then
  from=${FROM_DATABASE:-}
  [ -n "$from" ] || { echo "Needs FROM_DATABASE." >&2; exit 2; }
elif [ -n "${FROM_STORE:-}" ]; then
  [ -n "${TO_ROLE:-}" ] && [ -n "${TO_DATABASE:-}" ] || { echo "Needs TO_ROLE and TO_DATABASE." >&2; exit 2; }
  FROM_DATABASE=$FROM_STORE
elif [ "${FROM_THROUGH_CONNECTION:-}" = yes ]; then
  FROM_DATABASE=${database%%\?*}
  from=$url
  [ -n "$FROM_DATABASE" ] && [ -n "${TO_ROLE:-}" ] && [ -n "${TO_DATABASE:-}" ] || { echo "Needs TO_ROLE, TO_DATABASE and a held postgresql://ROLE:PASSWORD@HOST/DATABASE of the old database." >&2; exit 2; }
else
  TO_ROLE=${login%%:*}
  TO_DATABASE=${database%%\?*}
  from=${FROM_DATABASE:-}
  [ -n "$TO_ROLE" ] && [ -n "$TO_DATABASE" ] && [ -n "$from" ] || { echo "Needs FROM_DATABASE and a held postgresql://ROLE:PASSWORD@HOST/DATABASE." >&2; exit 2; }
  [ "$TO_DATABASE" != "$FROM_DATABASE" ] || [ "${TO_THROUGH_CONNECTION:-}" = yes ] || { echo "The new database is the old one." >&2; exit 2; }
fi
if [ "${TO_THROUGH_CONNECTION:-}" = yes ]; then
  ask() { psql -X -At "$url" -c "$1"; }
  write() { psql -X -q -v ON_ERROR_STOP=1 --single-transaction "$url"; }
else
  ask() { psql -X -At -d "$TO_DATABASE" -c "$1"; }
  write() { PGOPTIONS="-c role=$TO_ROLE" psql -X -q -v ON_ERROR_STOP=1 --single-transaction -d "$TO_DATABASE"; }
fi
if [ "${SCHEMAS:-public}" = all ]; then
  where="schemaname NOT IN ('pg_catalog', 'information_schema')"
  set --
else
  where="schemaname = 'public'"
  set -- --schema=public
fi
if [ -z "${TO_STORE:-}" ]; then has=$(ask "SELECT count(*) FROM pg_tables WHERE $where"); else has=0; fi
if [ "$has" != "0" ]; then echo "$TO_DATABASE already has $has tables; nothing copied."; exit 0; fi
for table in ${TABLES_ONLY:-}; do set -- "$@" --table="public.\"$table\""; done
for table in ${TABLES_LEFT_OUT:-}; do set -- "$@" --exclude-table="public.\"$table\""; done
dump=$(mktemp)
if [ -n "${FROM_STORE:-}" ]; then
  wal-g st get --no-decompress --no-decrypt "$FROM_STORE" "$dump" >/dev/null
else
  pg_dump --dbname="$from" --no-owner --no-privileges --no-publications --no-subscriptions "$@" > "$dump"
fi
if [ -n "${TO_STORE:-}" ]; then
  wal-g st put --no-compress --no-encrypt "$dump" "$TO_STORE" >/dev/null
  echo "put $FROM_DATABASE in the store as $TO_STORE: $(wc -c < "$dump") bytes, BLAKE3 $(b3sum --no-names "$dump" 2>/dev/null || echo unknown)"
  exit 0
fi
# An extension's comment belongs to the extension's owner, the server's own superuser, never to the new database's login.
grep -v -x -e 'CREATE SCHEMA public;' -e 'COMMENT ON SCHEMA public IS .*' -e 'COMMENT ON EXTENSION .*' "$dump" | write
echo "copied $FROM_DATABASE into $TO_DATABASE as $TO_ROLE: $(ask "SELECT count(*) FROM pg_tables WHERE $where") tables"
