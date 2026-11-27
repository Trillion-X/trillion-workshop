# tools/copy-rows-between-databases/

Copies named rows of one table from one of a person's Postgres-wire databases to another, inside the tool, and answers only counts and each key's version. It names no person's database, table or vault name.

Why: a workflow that carries whole rows through step answers and parameters makes the run's record as big as the rows (one toolkit's workflow rows are 1.34 MB; the run record reached 4.9 MB and the call died "Argument list too long"). Here a row's body is read from the source and written to the destination in one process; the run sees a few KB.

## Files

| File | Purpose |
|------|---------|
| `do-work/copy-rows.mjs` | The process `tool:copy-rows-between-databases` runs: reads the request on stdin, the source's connection string on descriptor 3 and the destination's on descriptor 4, copies each key's row whole as JSON in one destination transaction, prints `{ copied, updated, kept, missing, keys }`. `on_conflict` `do_nothing` keeps a key the destination has; `update_when_newer` replaces it when `version_column` is smaller there. A row's version is the md5 of the whole row as JSON. |
| `what-this-tool-does-and-how-to-run-it.json` | The Workshop row: input and output schemas, `key` (descriptor 3 and 4 from `source_credential_name` and `destination_credential_name`), `may_reach` (the run's proxy only) and the pinned `pg` tarballs. |
| `kits/copy-rows-between-databases.json` | Start here and a worked example. |
| `package.json` | The tests' own packages: `pg` and `embedded-postgres` (a real PostgreSQL started in a temp folder). |
| `part.json` | Nothing here is imported by other code. |
| `test/copy-rows.test.mjs` | Tests against a real server with two databases: copy, a rerun that copies nothing, a version kept and one updated when newer, an unknown key, a one-megabyte row, a refused request, the command as the engine runs it, and a failure naming no connection string. |

The tool imports `../../run-sql-in-my-database/do-work/through-the-run-proxy.mjs` (the CONNECT tunnel pg uses in a sandboxed run); its row lays that one file beside its own.

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `copyRows` | `({ source, destination, input, connect? }) => Promise<{ copied, updated, kept, missing, keys }>` | Copies the keys and always closes both connections. |
| `shapeOf` | `(input) => { tableText, key, keys, onConflict, version }` | The request's checks; names are plain identifiers, quoted by the tool. |
| `sayWithout` | `(error, ...connections) => string` | A failure's text with each connection string and its password removed. |
