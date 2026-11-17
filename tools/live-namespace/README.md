# tools/live-namespace/

The person's files (Namespace): their names over their own S3-compatible store, ranged reads, writes, moves, shares and
release, served as MCP tools over stdio and as a WebDAV folder on a loopback port, plus the browser and folder uploaders'
shared sender.

## What runs

`live-namespace` (this folder's Cargo crate) is the program. Started with the person's own state folder, it answers:

| Mode | What it serves |
|------|----------------|
| `mcp` | MCP over stdio. Each operation of `src/account_files/account-files-routes.json` is a tool of the same name, listed by `tools/list` from `mcp-tools.json`: `list_files`, `find_file`, `read_file`, `read_file_span`, `write_file`, `write_file_start` / `_piece` / `_finish`, `find_names`, `move_names`, `copy_names`, `set_aside`, `put_back`, `queue_release`, `release_gone_bytes`, `search`, `recent_files` and the rest. |
| `dav` | The WebDAV folder on `127.0.0.1:<settings.json dav.port>` (38481 as shipped), until stopped. Finder: Go, Connect to Server, `http://127.0.0.1:38481/`. A mounted file is read by byte range, never whole; a GET with no range of a large file is sent ranged. |
| `serve` | Both. |
| `account-files-bind [show] --state FOLDER` | Bind the origins of the person's files to them on purpose (`src/account_files/bind.rs`). |

    cd tools/live-namespace
    live-namespace mcp --state ~/namespace-state [--settings FILE]

## Where the names are kept

The names index is rows in the person's own SQL database, behind one small trait (`src/store`, `Rows`): read a row, read rows by id,
list a scope in id order a page at a time, change one row only if it is still at the version the caller read, a scope's change stamp,
the declared totals, and a word search of the file names. `SqlStore` is the one implementation, over SQLite or Postgres with the
same statements. Which one is the run's `settings.json` `store`: `{"sqlite": {"file": NAME}}` is a SQLite file of that name in the
state folder (the shipped setting, for a person's own computer and for tests) and `{"postgres": {host, port, database, user,
encrypted, password}}` is the person's own Postgres database, `password` the held name of the attached field that holds its
password. The credential is an attached descriptor like the byte store's, never an argument and never in a file. A database off this
computer is reached only encrypted. The Postgres side shares every statement with the SQLite side and its connection is built but
has not been run against a live Postgres server here.

The tables mirror the archive's `ns_name`, `ns_folder`, `ns_file`, `ns_chunk`, `ns_alias` and `ns_spans` column for column, with
`scope`, `version` and two request columns added (`src/store/tables.json`). Copying the account owner's rows in is one
`INSERT ... SELECT` a table (`src/store/copy-from-archive.sql`; the store's test runs that file over archive-shaped tables and reads
the copy back). Other small rows (origins, shares, uploads, locks, release and recent lists, results, usage days) are kept in
`ns_record`, one JSON value a row.

The bytes live in the person's own S3-compatible store and are read by the asked range. That store is the person's `files-store`
connection: the engine attaches each field to the run on a file descriptor `settings.json` `attached` names (secret 3, key-id 4,
bucket 5, endpoint 6, region 7); they are read once and never printed, logged or written. A first run makes the files from the
connection's endpoint, bucket, region and key id.

The WebDAV listener answers `127.0.0.1` and `localhost` only (a Host check), refuses a request that carries an Origin (a web page
sent it), and reads at most one PUT's bound of body (`settings.json` `dav.put_most_bytes`, 16 MiB; a larger file is sent with
`write_file_start`, `write_file_piece` and `write_file_finish`).

`share_file` refuses until the grant owner that mints a grant-bound share link is attached. `tools/share-anything` shares the
person's records, not file bytes in a byte store, so it cannot deliver a file; a delivery owner that serves a shared file's bytes by
range from the person's store is the missing piece, and `share_delivery.rs` is the seam it plugs into.

## Build and test

    cd tools/live-namespace && cargo build && cargo test

`cargo test` runs the unit tests inside `src/` (the store, the account files' own tests, the cause book) and `tests/` (the account
files over rows in memory and a byte store in memory, a stand-in S3 store on a loopback socket, the WebDAV folder, moves, release,
results and shares).

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | The crate `live-namespace`: library and program, pinned versions, clippy settings for the moved sources. |
| `Cargo.lock` | The resolved versions of this program. |
| `settings.json` | One run's settings: account name, where the rows are kept, WebDAV port and prefix, key prefix, call time, attached connection fields. |
| `mcp-tools.json` | Each MCP tool: name, description, input schema. |
| `tool-rows.json` | The Workshop row `tool:run-the-namespace-files-server`. |
| `kits/run-the-namespace-files-server.json` | The kit that row ships with. |
| `moved-from.json` | Each moved file's source path, commit and identities, and what was left behind. |
| `part.json` | The files the app imports from this folder. |
| `do-work/blake3.mjs`, `do-work/content-chunks-browser.mjs`, `do-work/send-a-file-to-namespace-browser.mjs` | The chunked sender the browser and folder uploaders share (moved from trillion-apps). |
| `src/main.rs` | The program: modes `mcp`, `dav`, `serve`, `account-files-bind`. |
| `src/serve/mod.rs` | One run: reads the attached connections, opens the rows, makes the files on a first run, `Namespace::call`. |
| `src/serve/mcp.rs` | MCP over stdio. |
| `src/serve/dav.rs` | The WebDAV listener. |
| `src/serve/settings.rs` | Reads and checks `settings.json`. |
| `src/lib.rs` | The library. |
| `src/store/` | The rows (see its README): `Rows`, `SqlStore`, `Link`, `tables.json`, `copy-from-archive.sql`. |
| `src/account_files/` | The account files, moved from trillion-rust `src/account_files` (see its README). |
| `src/cause_book/` | The engine's refusal causes, which every error here carries. |
| `src/host/https.rs`, `src/host/https/settings.json` | The one HTTP client the byte store's requests go through. |
| `src/host/mcp.rs` | The MCP message bounds, `tool_answer_fits`, `InputFault`. |
| `src/host/os.rs`, `src/host/os/*.rs` | The computer under the program: owner-only files, locks, the process table. |
| `src/host/secrets.rs` | `Held`: the attached connections, the SigV4 day key, vault names. |
| `src/host/tool_runs.rs` | The computer under the program, for the usage counts' pending file. |
| `tests/account_files_common/mod.rs` | The account files over rows and a byte port in memory. |
| `tests/account_files_dav.rs`, `account_files_dav_write.rs`, `account_files_move.rs`, `account_files_release.rs`, `account_files_results.rs`, `account_files_route.rs`, `account_files_share.rs` | The moved tests of the WebDAV folder, moves, release, results, the tool contract and shares. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `Namespace` | `Namespace::open(&Settings, &Path)`; `call(operation, &Value, current, fits) -> Result<Value, Failure>` | One run's door: the one call both the MCP tools and the WebDAV folder make. |
| `AccountFilesDoor` | `shipped()`, `call_while_fitting(state, store, account, ...)`, `operations()` | The account files' routes DATA and the call that checks the caller and answers. |
| `AccountFiles` | `list_files`, `read_file`, `write_file`, `share_file`, `move_names`, `dav`, `dav_write` ... | The tool contract over rows and a byte port (`src/account_files/mod.rs`). |
| `Rows` | `get`, `get_many`, `held_record_with_version`, `list_page`, `ids`, `mutate`, `stamp`, `totals`, `search`, `place` | What the files ask of the database (`src/store/mod.rs`). |
| `SqlStore` | `open(Link)`, `memory()` | The rows in SQLite or Postgres. |
| `secrets::Held` | `from_descriptors(&[(service, field, fd)])`, `plain`, `sigv4_day_key` | The attached connections; a value never leaves it. |
| `serve::mcp::serve` | `serve(Arc<Namespace>, impl BufRead, impl Write)` | MCP over stdio until its input ends. |
| `serve::dav::serve` | `serve(Arc<Namespace>, &Dav)` | The WebDAV listener. |

## Dependencies

**Depends on:** `trillion-rust/crates/content-crypto` (BLAKE3 identities, a path dependency beside this checkout as `tools/http-client` has), rusqlite (bundled SQLite), postgres and tokio-postgres-rustls (the person's Postgres), axum, tokio, reqwest and rustls (the HTTP client), serde, ring, hmac and sha2.

**Depended on by:** `tools/live-namespace/do-work` files are imported by Trillion-X/trillion-apps (`part.json`); `tool:run-the-namespace-files-server` runs the program.
