# tools/live-namespace/

The person's files (Namespace): their names over their own S3-compatible store, ranged reads, writes, moves, shares and
release, served as MCP tools over stdio to the engine, which runs it as a session that takes calls, so every caller (an AI, a
device's folder) reaches the files through the engine's one door; plus the browser and folder uploaders' shared sender.

## What runs

`live-namespace` (this folder's Cargo crate) is the program. Started with the person's own state folder, it answers:

| Mode | What it serves |
|------|----------------|
| `mcp` | MCP over stdio. Each operation of `src/account_files/account-files-routes.json` is a tool of the same name, listed by `tools/list` from `mcp-tools.json`: `list_files`, `find_file`, `read_file`, `read_file_span`, `write_file`, `write_file_start` / `_piece` / `_finish`, `find_names`, `move_names`, `copy_names`, `set_aside`, `put_back`, `queue_release`, `release_gone_bytes`, `search`, `recent_files` and the rest. |
| `this_computer` | An operation of `mcp` the run answers itself: the computer it is on, `{id, label}`, as the engine filled `--computer` (null when the engine did not start it). |
| `account-files-bind [show] --state FOLDER` | Bind the origins of the person's files to them on purpose (`src/account_files/bind.rs`). |

    cd tools/live-namespace
    live-namespace mcp --state ~/namespace-state [--settings FILE] [--computer JSON]

## Where the names are kept

The names index is rows in the person's own SQL database, behind one small trait (`src/store`, `Rows`): read a row, read rows by id,
list a scope in id order a page at a time, change one row only if it is still at the version the caller read, a scope's change stamp,
the declared totals, and a word search of the file names. `SqlStore` is the one implementation, over SQLite or Postgres with the
same statements. Which one is the run's `settings.json` `store`: `{"sqlite": {"file": NAME}}` is a SQLite file of that name in the
state folder (for a person with no database, and for tests) and `{"postgres": {"connection": NAME}}` is the person's own
Postgres database (the shipped setting, with `own-rows-postgres-connection` attached on descriptor 8), `NAME` the held name of the attached field that holds its connection string (`own-rows-postgres-connection`, the
credential the person's run-sql tool uses for the same database, reached on the loopback port the computer reports as `own-rows-postgres`).
The credential is an attached descriptor like the byte store's, never an argument and never in a file. A database off this computer is
reached only encrypted. The Postgres side shares every statement with the SQLite side: the store's tests run on it too, when
`NAMESPACE_POSTGRES_TEST_CONNECTION` holds the connection string of a throwaway database (each test gets a schema of its own).

The tables mirror the archive's `ns_name`, `ns_folder`, `ns_file`, `ns_chunk`, `ns_alias` and `ns_spans` column for column, with
`scope`, `version` and two request columns added (`src/store/tables.json`). Copying the account owner's rows in is one
`INSERT ... SELECT` a table (`src/store/copy-from-archive.sql`; the store's test runs that file over archive-shaped tables and reads
the copy back). Other small rows (origins, shares, uploads, locks, release and recent lists, results, usage days) are kept in
`ns_record`, one JSON value a row.

The bytes live in the person's own S3-compatible store and are read by the asked range. That store is the person's `files-store`
connection: the engine attaches each field to the run on a file descriptor `settings.json` `attached` names (secret 3, key-id 4,
bucket 5, endpoint 6, region 7); they are read once and never printed, logged or written. A first run makes the files from the
connection's endpoint, bucket, region and key id.

The program opens no port. Each tool call is answered on a thread of its own under its own id (`src/serve/mcp.rs`), so a call
that waits (`list_changes` with `wait`) never holds back the calls after it. A caller reaches it only through the engine: tools:run
at `@tools` with `{tool: "tool:your-files", call: {name, arguments}}` sends one MCP `tools/call` to the
account's one session of the row, started by the first call (trillion-rust src/tool_runs/tools/sessions.rs `call`).

`share_file` shares a file that is one object in the store through `tools/share-anything`: it signs a link that reads that one object for
the share's seconds (`src/account_files/share_delivery.rs`, SigV4 in the URL's query), keeps it in a record of the person's own,
`namespace-shared-file:<id>`, and runs `tool:share-anything` to share that record with a link anyone holding it can open, ending when
the byte link does (`src/account_files/share_anything.rs`). Stopping the share in share-anything is what stops the next reader. It
needs the records door the run is handed (`settings.json` `share`: the held name of the door's descriptor field and the https address
the share opens at; the row grants the right to write `namespace-shared-file` records and to run `tool:share-anything`) and is refused
without it. A file kept in chunks has no single object to link and is refused. share-anything's own reader that serves a share's
record (the engine's reach reader) is not built yet, so a share made now opens nothing until it is.

## Build and test

    cd tools/live-namespace && cargo build && cargo test

`cargo test` runs the unit tests inside `src/` (the store, the account files' own tests, the cause book) and `tests/` (the account
files over rows in memory and a byte store in memory, a stand-in S3 store on a loopback socket, moves, release, results and
shares).

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | The crate `live-namespace`: library and program, pinned versions, clippy settings for the moved sources. |
| `Cargo.lock` | The resolved versions of this program. |
| `settings.json` | One run's settings: account name, where the rows are kept, key prefix, call time, attached connection fields. |
| `mcp-tools.json` | Each MCP tool: name, description, input schema. |
| `tool-rows.json` | The Workshop rows: `tool:your-files`, the session the engine keeps open and reaches by calls (`session.calls`, the computer's own `live-namespace` program, the credentials mounted by name, the local door `own-rows-postgres`), and `tool:count-or-copy-your-file-rows`, one run of `counts` or `copy-archive` over the database alone. |
| `kits/your-files.json` | The kit those rows ship with. |
| `moved-from.json` | Each moved file's source path, commit and identities, and what was left behind. |
| `part.json` | The files the app imports from this folder. |
| `do-work/blake3.mjs`, `do-work/content-chunks-browser.mjs`, `do-work/send-a-file-to-namespace-browser.mjs` | The chunked sender the browser and folder uploaders share (moved from trillion-apps). |
| `src/main.rs` | The program: modes `mcp`, `account-files-bind`, `counts` (how many rows each names-index table holds, only reads), `copy-archive --from FILE` (copies an archive's ns_* tables, read-only, into the rows). |
| `src/serve/mod.rs` | One run: reads the attached connections, opens the rows, makes the files on a first run, `Namespace::call`. |
| `src/serve/mcp.rs` | MCP over stdio, each tool call on its own thread. |
| `src/serve/settings.rs` | Reads and checks `settings.json`. |
| `src/lib.rs` | The library. |
| `src/store/` | The rows (see its README): `Rows`, `SqlStore`, `Link`, `tables.json`, `copy-from-archive.sql`, `copy.rs`. |
| `src/account_files/` | The account files, moved from trillion-rust `src/account_files` (see its README). |
| `src/cause_book/` | The engine's refusal causes, which every error here carries. |
| `src/host/https.rs`, `src/host/https/settings.json` | The one HTTP client the byte store's requests go through. |
| `src/host/mcp.rs` | The MCP message bounds, `tool_answer_fits`, `InputFault`. |
| `src/host/os.rs`, `src/host/os/*.rs` | The computer under the program: owner-only files, locks, the process table. |
| `src/host/records_door.rs` | `RecordsDoor`: one `run_resource_operation` at the person's records and Workshop tools, over the door the run was handed. |
| `src/host/secrets.rs` | `Held`: the attached connections, the SigV4 day key, vault names. |
| `src/host/tool_runs.rs` | The computer under the program, for the usage counts' pending file. |
| `tests/account_files_common/mod.rs` | The account files over rows and a byte port in memory. |
| `tests/account_files_folder.rs`, `store_changes.rs`, `rows_in_both/` | What a native folder asks (changes, items, compare-and-set, pins, make_folder, bounds, thumbnails) and the store's change order, each in SQLite and in a real Postgres the tests start. |
| `tests/account_files_move.rs`, `account_files_release.rs`, `account_files_results.rs`, `account_files_route.rs`, `account_files_share.rs` | The moved tests of moves, release, results, the tool contract and shares. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `Namespace` | `Namespace::open(&Settings, &Path)`; `call(operation, &Value, current, fits) -> Result<Value, Failure>` | One run's door: the one call every MCP tool makes. |
| `AccountFilesDoor` | `shipped()`, `call_with_control_fitting(state, store, account, ...)`, `operations()` | The account files' routes DATA and the call that checks the caller and answers. |
| `AccountFiles` | `list_files`, `read_file`, `write_file`, `share_file`, `move_names` ... | The tool contract over rows and a byte port (`src/account_files/mod.rs`). |
| `Rows` | `get`, `get_many`, `held_record_with_version`, `list_page`, `ids`, `mutate`, `stamp`, `totals`, `search`, `place` | What the files ask of the database (`src/store/mod.rs`). |
| `SqlStore` | `open(Link)`, `memory()` | The rows in SQLite or Postgres. |
| `secrets::Held` | `from_descriptors(&[(service, field, fd)])`, `plain`, `sigv4_day_key` | The attached connections; a value never leaves it. |
| `serve::mcp::serve` | `serve(Arc<Namespace>, impl BufRead, impl Write + Send)` | MCP over stdio until its input ends and every call has answered. |

## Dependencies

**Depends on:** `content-crypto/` (BLAKE3 identities, vendored here from trillion-rust `crates/content-crypto` at 26c296c134bf, receipted in `moved-from.json`), rusqlite (bundled SQLite), postgres and tokio-postgres-rustls (the person's Postgres), axum, tokio, reqwest and rustls (the HTTP client), serde, ring, hmac and sha2.

**Depended on by:** `tools/live-namespace/do-work` files are imported by Trillion-X/trillion-apps (`part.json`); `tool:your-files` and `tool:count-or-copy-your-file-rows` run the program; tools/files-on-every-device calls `tool:your-files`.
