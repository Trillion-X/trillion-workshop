# tools/live-namespace/

The person's files (Namespace): their names over their own S3-compatible store, ranged reads, writes, moves, shares and
release, served as MCP tools over stdio and as a WebDAV folder on a loopback port, plus the browser and folder uploaders'
shared sender.

## What runs

`live-namespace` (this folder's Cargo crate) is the program. Started with the person's own state folder, it answers:

| Mode | What it serves |
|------|----------------|
| `mcp` | MCP over stdio. Each operation of `src/account_files/account-files-routes.json` is a tool of the same name, listed by `tools/list` from `mcp-tools.json`: `list_files`, `find_file`, `read_file`, `read_file_span`, `write_file`, `write_file_start` / `_piece` / `_finish`, `share_file`, `move_names`, `copy_names`, `set_aside`, `put_back`, `queue_release`, `release_gone_bytes` and the rest. |
| `dav` | The WebDAV folder on `127.0.0.1:<settings.json dav.port>` (38481 as shipped), until stopped. Finder: Go, Connect to Server, `http://127.0.0.1:38481/`. A mounted file is read by byte range, never whole; a GET with no range of a large file is sent range by range. |
| `serve` | Both. |
| `account-files-bind STORE_FILE ACCOUNT [show \| into STATE_FOLDER]` | Bind a store file to its account files on purpose (`src/account_files/bind.rs`). |

    cd tools/live-namespace
    live-namespace mcp --state ~/namespace-state [--settings FILE]

The names live in a record store file in the state folder (never a temporary folder: the store refuses it). The bytes live in the
person's own S3-compatible store and are read by the asked range. The store is the person's `files-store` connection: the engine
attaches each field to the run on a file descriptor `settings.json` `attached` names (secret 3, key-id 4, bucket 5, endpoint 6,
region 7); they are read once and never printed, logged or written. A first run makes the store file from the connection's
endpoint, bucket, region and key id.

The WebDAV listener answers `127.0.0.1` and `localhost` only (a Host check), refuses a request that carries an Origin (a web page
sent it), and reads at most one PUT's bound of body (`settings.json` `dav.put_most_bytes`, 16 MiB; a larger file is sent with
`write_file_start`, `write_file_piece` and `write_file_finish`).

`share_file` refuses until the grant owner that mints a share link is attached: that owner is not part of this program.

## Build and test

`.cargo/config.toml` of this folder makes the bundled SQLite with the scan counters the record store meters its reads by, so run
cargo from this folder:

    cd tools/live-namespace && cargo build && cargo test

`cargo test` runs `tests/` (the account files over a record store in memory and a byte store in memory, a stand-in S3 store on a
loopback socket, the WebDAV folder, moves, release, results, shares and the funded byte budget). The unit tests inside
`src/account_files/*.rs` are not run: they need the engine's test world (`crate::simulation`, the engine's vault), which this tool
does not carry, so the crate's library has `test = false`.

## Files

| File | Purpose |
|------|---------|
| `Cargo.toml` | The crate `live-namespace`: library and program, the versions of the engine's lock, clippy and cfg settings for the moved sources. |
| `Cargo.lock` | The resolved versions of this program. |
| `.cargo/config.toml` | Builds SQLite with `SQLITE_ENABLE_STMT_SCANSTATUS`. |
| `settings.json` | One run's settings: account name, WebDAV port and prefix, key prefix, attached connection fields. |
| `mcp-tools.json` | Each MCP tool: name, description, input schema. |
| `tool-rows.json` | The Workshop row `tool:run-the-namespace-files-server`. |
| `moved-from.json` | Each moved file's source path, commit and identities. |
| `part.json` | The files the app imports from this folder. |
| `do-work/blake3.mjs`, `do-work/content-chunks-browser.mjs`, `do-work/send-a-file-to-namespace-browser.mjs` | The chunked sender the browser and folder uploaders share (moved from trillion-apps). |
| `src/main.rs` | The program: modes `mcp`, `dav`, `serve`, `account-files-bind`. |
| `src/serve/mod.rs` | One run: reads the attached connection, makes the store on a first run, `Namespace::call`. |
| `src/serve/mcp.rs` | MCP over stdio. |
| `src/serve/dav.rs` | The WebDAV listener. |
| `src/serve/settings.rs` | Reads and checks `settings.json`. |
| `src/lib.rs` | The library: the record store from `tools/keep-lists-of-rows/account-state`, the engine's files it reads, and `host/`. |
| `src/account_files/` | The account files, moved from trillion-rust `src/account_files` (see its README). |
| `src/cause_book/cause.rs`, `foreign_causes.rs`, `foreign_storage_causes.rs`, `settings.json`, `words.json` | The engine's refusal causes, which every error here carries. |
| `src/record_indexes.rs`, `src/record_indexes/current.rs`, `src/record_indexes/installed.rs` | The engine's record index reads, as the record store reads them. |
| `src/resource_authority.rs` | The engine's scope, route and admitted-call types the records read (the byte budget in `account-state` stands on it). |
| `src/engine/signed_authority.rs` | The engine's signed-authority clock and fresh-rights seam the funded byte budget reads. |
| `src/host/account.rs` | `AccountError` and the report of this computer's store budget; no copies of an account run here. |
| `src/host/account_rights.rs`, `src/host/account_rights/run_rules.rs` | What one call of the routes touches, per the routes DATA. |
| `src/host/https.rs`, `src/host/https/settings.json` | The one HTTP client the byte store's requests go through. |
| `src/host/local_account.rs` | `ProcessIdentity` and the own-records names the record store reads. |
| `src/host/mcp.rs`, `src/host/mcp/settings.json` | The MCP message bounds, `tool_answer_fits`, `byte_page`, `InputFault`. |
| `src/host/os.rs`, `src/host/os/owner_files_posix.rs`, `src/host/os/process_table_proc_pidinfo.rs`, `src/host/os/process_table_procfs.rs` | The computer under the program: owner-only files, locks, the process table. |
| `src/host/rule_bindings.rs` | List formula fields: this program holds no list, so none is derived. |
| `src/host/secrets.rs` | `Held`: the attached connection, the SigV4 day key, vault names. |
| `src/host/tool_runs.rs` | The installed tools (none) and `os`. |
| `src/host/workspace_domain.rs` | Percent-decoding of paths. |
| `tests/account_files_common/mod.rs` | The account files over a record store and a byte port in memory. |
| `tests/account_files_dav.rs`, `account_files_dav_write.rs`, `account_files_move.rs`, `account_files_release.rs`, `account_files_results.rs`, `account_files_route.rs`, `account_files_share.rs`, `resource_budget_account_files.rs` | The moved tests of the WebDAV folder, its writes, moves between stores, byte release, results, the operations, shares and the funded byte budget. |
| `test-support/resource_budget.rs` | The protected-book fixtures the budget test reads. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `Namespace` | `Namespace::open(&Settings, &Path)`; `call(operation, &Value, current, fits) -> Result<Value, Failure>` | One run's door: the one call both the MCP tools and the WebDAV folder make. |
| `AccountFilesDoor` | `shipped()`, `call_while_fitting(...)`, `operations()` | The account files' routes DATA and the call that opens the store, checks the caller and answers. |
| `AccountFiles<S>` | `list_files`, `read_file`, `write_file`, `share_file`, `move_names`, `dav`, `dav_write` ... | The tool contract over a record store and a byte port (`src/account_files/mod.rs`). |
| `secrets::Held` | `from_descriptors(&[(&str, i32)])`, `plain`, `sigv4_day_key` | The attached connection; a value never leaves it. |
| `serve::mcp::serve` | `serve(Arc<Namespace>, impl BufRead, impl Write)` | MCP over stdio until its input ends. |
| `serve::dav::serve` | `serve(Arc<Namespace>, &Dav)` | The WebDAV listener. |

## Dependencies

**Depends on:** `tools/keep-lists-of-rows/account-state` (the record store, included as source), `trillion-rust/crates/content-crypto` (BLAKE3 identities, a path dependency beside this checkout as `tools/http-client` has), rusqlite (bundled SQLite), axum, tokio, reqwest and rustls (the HTTP client), serde, ring, hmac and sha2.

**Depended on by:** `tools/live-namespace/do-work` files are imported by Trillion-X/trillion-apps (`part.json`); `tool:run-the-namespace-files-server` runs the program.
