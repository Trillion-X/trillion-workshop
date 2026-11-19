# tools/run-sql-in-my-database/

The PostgreSQL kit's own tool (tools/keep-a-postgres-database-on-a-computer runs the database; this tool talks to it). It names no person's database or vault name.

Runs one SQL statement, as written, in a person's own Postgres-wire database and answers `{ columns, rows, row_count }` or the database's own error text, for an AI that has no shell (a phone or web chat). It runs the role recipes that make, grant and take away a kind of login.

## Files

| File | Purpose |
|------|---------|
| `do-work/run-sql.mjs` | The process `tool:run-sql-in-my-database` runs: reads the request on stdin, the connection string on descriptor 3 and a recipe's standing role connection on descriptor 4, sends one prepared statement (or a role recipe's statements in one transaction) and prints the answer. |
| `read-data/role-recipes.json` | The role recipes: per kind of login, the `create` and `drop` statements as the server's own `format()` strings (`%1$I` role, `%2$L` password, `%3$L` valid until, `%4$I` database, `%5$I` the held role connection's database). `read-only` is a share that may only read; `may-change-rows` is a member who reads, adds, changes and removes rows of every table, now and later, but never changes a table, makes a login or reaches another database; `a-login` is only a login (its password a verifier, a held one or minted), made by a login that may make roles where the database's owner may not, and `may-change-rows-for-a-login` gives such a login the rights of `may-change-rows`, run by the database's owner in its own database (it makes and drops no login, so the owner needs no right to make roles); `own-database` is a login and the database it owns, made by the login of whoever runs the computer (CREATEROLE and CREATEDB), so a computer's row names no pursuit. A new kind is one entry. |
| `do-work/make-a-login-verifier.mjs` | Run by whoever will hold a login to someone else's database, on their own computer: reads their password or kept connection string on stdin and prints only the SCRAM-SHA-256 verifier (`{password_verifier}`), which the owner gives as `recipe.password_verifier`. The password never leaves that computer. |
| `do-work/through-the-run-proxy.mjs` | pg's `stream`: a CONNECT tunnel through the run's proxy to the database's address. |
| `tool-rows.json` | The Workshop row: input and output schemas, `credential_mounts` (the connection held under the name `credential_name` gives, on descriptor 3, and a recipe's standing role connection under the name `role_credential_name` gives, on descriptor 4), `internet: true` (the run's proxy only) and the pinned npm tarballs of `pg` 8.23.1 and its twelve dependencies (`invoke.packages`, each with its BLAKE3), placed under `/opt/node_modules`. |
| `kits/run-sql-in-my-database.json` | Start here and a worked example. |
| `package.json`, `package-lock.json` | The tests' own packages: `pg` pinned to the version the row pins, and `embedded-postgres` (a real PostgreSQL 18 started in a temp folder, no sudo). |
| `part.json` | Nothing here is imported by other code. |
| `test/run-sql.test.mjs` | 22 tests against a real server: a pursuit owner that may not make roles gives rights to a login the computer's role maker made from a verifier (the owner alone and the role maker alone are each refused, a login alone reaches nothing, leaving takes the rights back and then the login, and its rows stay), a login made from a verifier someone else sent (they sign in with the password only they hold, the server keeps the verifier as sent, a wrong password and the drop refuse), a verifier's checks, one statement, two refused, per-login limits set as a login is made and a short standing password refused, the SELECT-only login cannot write, the timeout, the refused login without its password, the command as the engine runs it, and the role recipes (a standing read-only login made from the held role connection and dropped, a minted one that stops at its time, a minted member that changes rows of a table made after it but no table and no login, all or nothing in one transaction, a login the superuser made dropped once the owner is its admin, and an own-database login and database the operator makes, cannot open and drops). |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `runSql` | `({ connection, roleConnection?, input, connect? }) => Promise<{ columns, rows, row_count }>` | Runs the request as the connection's login and always closes the connection. |
| `shapeOf` | `(input) => { kind: 'sql' \| 'recipe', ... }` | The two request shapes: `{ sql, params? }` and `{ recipe: { name, action, role?, valid_until? } }`. |
| `sayWithout` | `(error, ...connections) => string` | A failure's text with each connection string and its password removed. |

## Design

- **One statement** is the protocol's rule: every statement is a named prepared statement (extended query protocol), and the server refuses text holding more than one command (`cannot insert multiple commands into a prepared statement`). No parser here.
- **Read-only** is the login's rule. credential_name is the vault name the person saved a connection under (the row lists none: the engine mounts the value held under the name the run gives), a login that may write or one that may only read; the second is a role granted SELECT only. The tool has no read-only flag.
- **Role recipes.** A read role exists only when a recipe makes one; no computer makes it by default. The owner login runs the recipe (it needs CREATEROLE, given by `tools/start-a-computer` `set-up-postgres-role.sh` with `PG_MAKES_ROLES=yes`), every statement filled by the server's `format()` and all of them in one transaction, unless the recipe says `in_one_transaction: false`: Postgres makes and drops a database only outside a transaction block, so `own-database` runs its statements one by one on one connection. It makes the role and database the held role connection names, closed to every other login (the operator's too); the operator takes the right to act for the new role only for the statements that need it, and gives it back. A standing login takes its role and password from the held connection named by `role_credential_name` (descriptor 4) and is never answered; a minted one gets a made-up password and `VALID UNTIL`, and its connection is answered once. A login for someone else takes `recipe.password_verifier` and `recipe.role`: the SCRAM-SHA-256 verifier they made from a password only they keep (`do-work/make-a-login-verifier.mjs`), which Postgres stores unchanged as the role's password, so neither this computer nor any answer ever holds their password; nothing but the role is answered. `drop` revokes what `create` granted and drops the role.
- **Per-login limits.** A recipe's `limits` rows are the limits a create may set (`connection_limit`, `statement_timeout_ms`), each one `ALTER ROLE` statement filled by the server's `format()` with a whole number checked above zero, run only when the caller gives it. No number is chosen here: the caller passes what the computer's measured capacity allows. A standing login's password must be at least 43 characters (32 random bytes as base64url), and a minted one is 32 random bytes.
- **No added layer.** No shape, list name or record type: the SQL goes through as written. The tool makes no table and names none: a list is a table the person's AI makes in the database's own language.
- **Reach.** The process runs sandboxed with internet:true, so it reaches the network only through the run's own loopback proxy (HTTPS_PROXY). Each connection is one CONNECT tunnel to the host and port the connection string names (do-work/through-the-run-proxy.mjs), and the engine opens it only to a host every value the run holds may go to (the vault entry's `hosts`). The database's own TLS runs inside the tunnel, checked against its name (`sslmode=verify-full`). The row names no local port and no host.
- The connection string is never in the request, argv, a file or the environment, and no answer or error holds it.

## Dependencies

**Depends on:** `pg` 8.23.1 (MIT), the engine's `credential_mounts`, its run proxy and `packages` rows.

**Depended on by:** nothing in the Workshop imports it; a person's AI calls it, or uses the database directly.
