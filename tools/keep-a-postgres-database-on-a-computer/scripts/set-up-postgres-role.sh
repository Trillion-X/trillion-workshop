# Makes the database role a held connection string names and the database it owns, so a run of it twice changes nothing.
# It runs as the database server's own account, over the server's unix socket (peer authentication), and reads the
# connection string, postgresql://ROLE:PASSWORD@HOST/DATABASE, from the sealed credential $SECRET_NAME. The values reach psql
# through its environment and its standard input, never its arguments.
#
# The role owns DATABASE, and no other role (PUBLIC) may connect to it, so the store, not a query rule, keeps one person's rows
# from another's. PG_MAKES_ROLES=yes also lets the role make and drop roles of its own (CREATEROLE), as the role recipes of
# tools/run-sql-in-my-database do for a share or a minted login, and makes it the admin (not a member) of every other login
# its database admits, so a login made before it could make roles is the owner's to drop too; any other value takes CREATEROLE
# away. PG_ACTS_AS=ROLE makes the login one that acts as ROLE (an AI's own login to its person's database): a member of ROLE that
# inherits its rights, whose sessions in DATABASE start as ROLE, so what it makes is ROLE's; DATABASE is then ROLE's, never the
# login's.
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
PG_MAKES_ROLES=${PG_MAKES_ROLES:-no}
PG_ACTS_AS=${PG_ACTS_AS:-}
export PG_ROLE PG_PASSWORD PG_DATABASE PG_MAKES_ROLES PG_ACTS_AS
exec psql -X -q -v ON_ERROR_STOP=1 -d postgres -f - <<'SQL'
\getenv role PG_ROLE
\getenv password PG_PASSWORD
\getenv database PG_DATABASE
\getenv makes_roles PG_MAKES_ROLES
\getenv acts_as PG_ACTS_AS
SELECT format('CREATE ROLE %I LOGIN', :'role') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'role', :'password') \gexec
SELECT format('ALTER ROLE %I %s', :'role', CASE WHEN :'makes_roles' = 'yes' THEN 'CREATEROLE' ELSE 'NOCREATEROLE' END) \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'database', COALESCE(NULLIF(:'acts_as', ''), :'role')) WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'database') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'database') \gexec
SELECT format('GRANT %I TO %I WITH ADMIN TRUE, INHERIT FALSE, SET FALSE', r.rolname, :'role') FROM pg_roles r WHERE :'makes_roles' = 'yes' AND NOT r.rolsuper AND r.rolname <> :'role' AND NOT pg_has_role(r.oid, :'role', 'MEMBER') AND has_database_privilege(r.oid, :'database', 'CONNECT') \gexec
SELECT format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', :'acts_as', :'role') WHERE :'acts_as' <> '' \gexec
SELECT format('ALTER ROLE %I IN DATABASE %I SET role = %L', :'role', :'database', :'acts_as') WHERE :'acts_as' <> '' \gexec
SQL
