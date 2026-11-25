# Empties one stale copy so copy-a-database.sh can copy it again: drops TO_DATABASE (ending its sessions) and makes it again,
# empty, owned by TO_ROLE and closed to every other login (PUBLIC), the way set-up-postgres-role.sh first made it; template1
# gives it this server's extensions again. A cutover uses it while the old database's writers are paused, when the first copy
# no longer compares equal (workflow:move-a-pursuits-databases-onto-another-server, copy-again-or-keep). It runs as the
# database server's own account over its unix socket. It acts only when REPLACE_STALE_COPY names the same database as
# TO_DATABASE, so a unit cannot drop a database by a mistyped name, and it never touches the old server. The rights other
# logins had in the dropped copy (a site's own login, a reader) are given again by their own files after the copy.
set -eu
[ -n "${TO_ROLE:-}" ] && [ -n "${TO_DATABASE:-}" ] || { echo "Needs TO_ROLE and TO_DATABASE." >&2; exit 2; }
[ "${REPLACE_STALE_COPY:-}" = "$TO_DATABASE" ] || { echo "REPLACE_STALE_COPY must name $TO_DATABASE to drop it." >&2; exit 2; }
export TO_ROLE TO_DATABASE
exec psql -X -q -v ON_ERROR_STOP=1 -d postgres -f - <<'SQL'
\getenv role TO_ROLE
\getenv database TO_DATABASE
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'database') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'role') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database') \gexec
\echo emptied :database again for a new copy, owned by :role
SQL
