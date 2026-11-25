# Keep a PostgreSQL database on a computer

PostgreSQL's own files for a computer row: the server unit, its access file, and the scripts that make its roles, back it up and test a restore. A computer row names these files by path, and start-a-computer applies them knowing no program (the plan that no general tool knows a program, K2, Nov 18 2026; they lived in tools/start-a-computer until then). Pick it from a setup list; nothing general names PostgreSQL.

## What is here

- `serve-postgres.service`: the server unit (a row's unit `template`).
- `prepare-a-database-unit.mjs`: the unit's `prepare`. It turns the unit's `reach` into the listen line, the access file, and the ports they open.
- `scripts/set-up-postgres-role.sh`, `scripts/back-up-postgres.sh`, `scripts/restore-a-postgres-backup.sh`, `scripts/copy-backups-to-a-second-place.sh`, `scripts/restore-a-backup-on-a-spare-computer.sh`, `scripts/copy-a-database.sh`: a `run-a-script` unit's `script`.
- `test/a-database-unit.test.mjs`: these files rendered by start-a-computer from a made-up row.

## The server unit

The server unit (`tools/keep-a-postgres-database-on-a-computer/serve-postgres.service`) runs `postgres` as the unit's `user` on `data_dir` (`initdb` runs at the first start, data checksums on), reading the `settings_file` the row's `settings_lines` render, one line each, and the sealed credential `secret_name` (a file of `NAME=value` lines the server and the archive command it starts read).

## Who reaches it: `reach`

The unit names `prepare: tools/keep-a-postgres-database-on-a-computer/prepare-a-database-unit.mjs` and `hba_file`. `reach` is a list of entries, each one way in: `for` (the tool or unit it lets in, for example `tool:run-sql-in-my-database`), `listen` (an address the server listens on), `hba` (rows in the server's own words: `type`, `database`, `user`, `address`, `method`), `credential` (the held name of the connection the caller uses), and `firewall_allow` when it opens a port. The server's `listen_addresses` is every entry's `listen` (none means no network listener), and its access file, at the unit's `hba_file`, holds every entry's `hba` rows and nothing else; a row's `settings_lines` may not set either. A database unit without `reach` keeps PostgreSQL's own defaults.

## The scripts

The scripts: `set-up-postgres-role.sh` reads a held connection string (`postgresql://ROLE:PASSWORD@HOST/DATABASE`) and makes the role, its password and the database it owns, with the right to connect taken from every other role (the store, not a query rule, keeps one person's rows from another's); `PG_MAKES_ROLES=yes` lets the role make roles of its own, which the role recipes of `tools/run-sql-in-my-database` need (a read-only share, standing or minted with `VALID UNTIL`). `PG_MAKES_DATABASES=yes` lets it make databases: with both, it is the login of whoever runs the computer, which makes each new pursuit's database and owner role as SQL, so the computer's row names no pursuit. No computer makes a read role by default. `back-up-postgres.sh` takes a WAL-G base backup, switches the WAL segment and waits until the archive holds it, so each backup restores without a later one. `restore-a-postgres-backup.sh` first makes the live server switch WAL segment and waits until the archive holds it, and takes the live server's list of databases then; it fetches the newest backup into the run's private scratch folder, starts a second server from it with no network listener, replays the archived WAL and refuses unless every database on that list is there and opens, so it names no database and a new one is proved by its WAL before the next base backup. `copy-backups-to-a-second-place.sh` copies the backup store's newest backup, and the WAL archived from its start until now, to a second place over SSH with WAL-G's own copy (each object as it is), and refuses unless the second place then lists that backup; its sealed credential holds the store's key and the second place's SSH key, and the unit's environment names both places (the store's own variables, and `SECOND_WALG_SSH_PREFIX`, `SECOND_SSH_PORT`, `SECOND_SSH_USERNAME`). A second place whose own snapshots the computer cannot remove keeps a copy nothing on the computer can delete. `restore-a-backup-on-a-spare-computer.sh` is a restore drill's one unit on a spare computer that runs no database of its own: it fetches the newest backup, replays the archived WAL up to `RECOVERY_TARGET_LSN` when the unit names one (else to the archive's end), is promoted with nothing archived, and prints every table's row count per database and the fetch and replay times, so the drill compares them with the live store's counts taken at that point. `copy-a-database.sh` copies one database's public schema (tables, rows, views, functions, triggers, sequences, comments) into a new, empty database named by the held connection string, made as that database's own login, so a database can take a new name with nothing lost: `FROM_DATABASE` names the old one, which is only read; `TABLES_LEFT_OUT` or `TABLES_ONLY` (names, spaces between) leave tables out or pick them, such as a sign-in tool's tables that go to a store of their own. `SCHEMAS=all` copies every schema, not only public. `TO_THROUGH_CONNECTION=yes` writes through the held connection itself (TLS to its host, as its own login, with `PGSSLROOTCERT=system`), so the new database may be on another server; the script then runs on the old database's server. It refuses a new database that already has a table, and copies in one transaction.

## Proving a moved database lost nothing

Two programs run on any computer that can reach both databases, each opened by its own login, with the connection strings in the environment only:
- `do-work/compare-two-databases.mjs` (`FIRST_CONNECTION`, `SECOND_CONNECTION`, optional schema) compares every object (columns, constraints, indexes, views, functions, triggers, comments, sequences' values, extensions; owners and grants left out) and every table's rows: count and BLAKE3 of the rows as text, sorted, json read as jsonb. A table that differs gets the count of rows only in each; no row value is printed.
- `do-work/carry-rows-to-new-database.mjs` (`OLD_CONNECTION`, `NEW_CONNECTION`, table names) brings what the old database got after the copy: missing columns, then every row by primary key, then sequences moved forward, in one transaction on the new one. `--deletes-too` also takes out keys the old one removed (only while the new one has no writer yet); `--keep-new` keeps the new one's row where both have the key (once it has).

The order of a move with nothing dropped: copy (`copy-a-database.sh`), compare, switch each program's credential through its row (a program on a socket restarts without dropping a request), carry what the old one got meanwhile, compare again. The old database is kept until its owner says it may go.

## A row that uses it

```json
{"unit": "example-database.service",
 "template": "tools/keep-a-postgres-database-on-a-computer/serve-postgres.service",
 "prepare": "tools/keep-a-postgres-database-on-a-computer/prepare-a-database-unit.mjs",
 "hba_file": "/etc/example-database/pg_hba.conf",
 "reach": [{"for": "this computer's own jobs", "hba": [{"type": "local", "database": "all", "user": "all", "method": "peer"}]}]}
```

A backup job is a `run-a-script` unit whose `script` is `tools/keep-a-postgres-database-on-a-computer/scripts/back-up-postgres.sh`, run by a `run-on-a-timer` unit. Where the backups go is the row's own value (WAL-G's settings in the sealed credential), never this folder's.
