# tools/run-sql-in-my-database/

Runs one SQL statement, as written, in a person's own Postgres-wire database and answers `{ columns, rows, row_count }` or the database's own error text, for an AI that has no shell (a phone or web chat). The same tool keeps a recipe step's `row:<list>` output as a row of a table of the person's database.

## Files

| File | Purpose |
|------|---------|
| `do-work/run-sql.mjs` | The process `tool:run-sql-in-my-database` runs: reads the request on stdin and the connection string on descriptor 3, sends one prepared statement and prints the answer. |
| `tool-rows.json` | The Workshop row: input and output schemas, `credential_mounts` (one held connection per `credential_name`, on descriptor 3), `local_doors` (`own-rows-postgres`) and the pinned npm tarballs of `pg` 8.23.1 and its twelve dependencies (`invoke.packages`, each with its BLAKE3), placed under `/opt/node_modules`. |
| `kits/run-sql-in-my-database.json` | Start here and a worked example. |
| `package.json`, `package-lock.json` | The tests' own packages: `pg` pinned to the version the row pins, and `embedded-postgres` (a real PostgreSQL 18 started in a temp folder, no sudo). |
| `part.json` | Nothing here is imported by other code. |
| `test/run-sql.test.mjs` | 12 tests against a real server: one statement, two refused, the SELECT-only login cannot write, the step-output upsert, the timeout, the quoted list name, the refused login without its password, and the command as the engine runs it. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `runSql` | `({ connection, input, connect? }) => Promise<{ columns, rows, row_count }>` | Runs the request as the connection's login and always closes the connection. |
| `shapeOf` | `(input) => { kind: 'sql' \| 'row', ... }` | The two request shapes: `{ sql, params? }` and `{ list, id, value }`. |
| `sayWithout` | `(error, connection) => string` | A failure's text with the connection string and its password removed. |

## Design

- **One statement** is the protocol's rule: every statement is a named prepared statement (extended query protocol), and the server refuses text holding more than one command (`cannot insert multiple commands into a prepared statement`). No parser here.
- **Read-only** is the login's rule. The cart line names `own-rows-postgres-connection`, or `own-rows-postgres-read-connection` for a share that may only read; the second is a role granted SELECT only. The tool has no read-only flag.
- **No added layer.** No shape, list name or record type: the SQL goes through as written. The step-output upsert is the only table the tool names, and only because the runner asks for `row:<list>`: `(id text primary key, value jsonb, updated_at timestamptz)`, made when missing, the list name quoted as an identifier.
- **Reach.** The process runs sandboxed and reaches only loopback ports the computer reports by name; the row names `own-rows-postgres`. A computer that runs the database (or the end of a tunnel to it) reports `own-rows-postgres` in its `local_ports`. A database on another host is reachable only through such a tunnel end.
- The connection string is never in the request, argv, a file or the environment, and no answer or error holds it.

## Dependencies

**Depends on:** `pg` 8.23.1 (MIT), the engine's `credential_mounts`, `local_doors` and `packages` rows.

**Depended on by:** `tools/workflows/arrivals/step-outputs.json` (`keepers.row`).
