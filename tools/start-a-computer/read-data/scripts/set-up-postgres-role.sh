# Makes the database role a held connection string names, and its database or its read right, so a run of it twice changes
# nothing. It runs as the database server's own account, over the server's unix socket (peer authentication), and reads the
# connection string, postgresql://ROLE:PASSWORD@HOST/DATABASE, from the sealed credential $SECRET_NAME. The values reach psql
# through its environment and its standard input, never its arguments.
#
# PG_KIND owner: the role owns DATABASE, and no other role (PUBLIC) may connect to it, so the store, not a query rule, keeps
#   one person's rows from another's.
# PG_KIND read: the role may connect to DATABASE (the connection string names the owner's database) and read every table in
#   it, through the server's predefined pg_read_all_data role, and holds no other right.
set -eu
url=$(cat "$CREDENTIALS_DIRECTORY/$SECRET_NAME")
rest=${url#*://}
login=${rest%%@*}
PG_ROLE=${login%%:*}
PG_PASSWORD=${login#*:}
database=${rest#*@}
database=${database#*/}
PG_DATABASE=${database%%\?*}
[ -n "$PG_ROLE" ] && [ -n "$PG_PASSWORD" ] && [ -n "$PG_DATABASE" ] || { echo "The held connection string is not postgresql://ROLE:PASSWORD@HOST/DATABASE." >&2; exit 2; }
export PG_ROLE PG_PASSWORD PG_DATABASE PG_KIND
exec psql -X -q -v ON_ERROR_STOP=1 -d postgres -f - <<'SQL'
\getenv role PG_ROLE
\getenv password PG_PASSWORD
\getenv database PG_DATABASE
\getenv kind PG_KIND
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'role', :'password') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database', :'role') WHERE :'kind' = 'owner' AND NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database') WHERE :'kind' = 'owner' \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'database', :'role') WHERE :'kind' = 'read' \gexec
SELECT format('GRANT pg_read_all_data TO %I', :'role') WHERE :'kind' = 'read' \gexec
SQL
