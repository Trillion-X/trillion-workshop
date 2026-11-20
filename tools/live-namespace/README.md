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
| `serve-shares --state FOLDER [--settings FILE]` | The public byte route of a share (below): `GET`/`HEAD` `/share/<id>/<key>` on a loopback address, by range. |
| `account-files-bind [show] --state FOLDER` | Bind the origins of the person's files to them on purpose (`src/account_files/bind.rs`). |
| `rows --state FOLDER (--login-fd N \| --sqlite FILE)` | MCP over stdio: the names rows answered to the files run (`src/serve/rows.rs`), one tool per operation of `Rows`, each answer a file of bytes. It is tool:your-files-names, the one run that holds the database login. |
| `import-index --from FOLDER --origin ID --state FOLDER (--login-fd N \| --sqlite FILE) [--under FOLDER] [--batch N] [--look]` | Brings an earlier store's exported index (its tables as `<table>__NNNNNN.ndjson`) into the person's rows (`src/account_files/import_index.rs`): every name whose file its spans and chunks prove, with its file, span pages, chunks (keys carried as they are, at origin row `ID`) and folders, added through the store's `add_new` in batches (rows held or removed are left as they are, so it may run again). Prints what the export makes first; `--look` stops there. |

    cd tools/live-namespace
    live-namespace mcp --state ~/namespace-state [--settings FILE] [--computer JSON]

## Where the names are kept

The names index is rows in the person's own SQL database, behind one small trait (`src/store`, `Rows`): read a row, read rows by id,
list a scope in id order a page at a time, change one row only if it is still at the version the caller read, a scope's change stamp,
the declared totals, and a word search of the file names. `SqlStore` is the one implementation, over SQLite or Postgres with the
same statements. Which one is the run's `settings.json` `store`: `{"sqlite": {"file": NAME}}` is a SQLite file of that name in the
state folder (for a person with no database, and for tests) and `{"postgres": {"connection": NAME}}` is the person's own
Postgres database opened by the run itself, `NAME` the held name of the attached field that holds its connection string (`own-rows-postgres-connection`, the
credential the person's run-sql tool uses for the same database, reached by its address; in a run the engine keeps in its sandbox, through the run's proxy, src/store/through_the_run_proxy.rs).
The shipped setting is the third kind, `{"run": {"tool": "tool:your-files-names", "fd": 9}}`: the rows a session of tool:your-files-names keeps
(`live-namespace rows`, holding the database login alone), reached by one call per `Rows` operation through the run's door
(`src/store/by_calls.rs`, `src/store/through_the_door.rs`). The engine lets one process reach only the hosts every value it holds may
go to, so a run holding the byte store's key and the database login could reach none; split this way, tool:your-files holds the byte
store's key alone. Each operation is atomic on its own (a change is a compare-and-set on the row's version), so no transaction spans calls.
The credential is an attached descriptor like the byte store's, never an argument and never in a file. A database off this computer is
reached only encrypted. The Postgres side shares every statement with the SQLite side: the store's tests run on it too, when
`NAMESPACE_POSTGRES_TEST_CONNECTION` holds the connection string of a throwaway database (each test gets a schema of its own).

The tables are `ns_name`, `ns_folder`, `ns_file`, `ns_chunk`, `ns_alias` and `ns_spans`, each with its own columns and
`scope`, `version` and two request columns added (`src/store/tables.json`). Other small rows (origins, shares, uploads, locks, release and recent lists, results, usage days) are kept in
`ns_record`, one JSON value a row.

The bytes live in the person's own S3-compatible store and are read by the asked range. That store is the person's `files-store`
connection: the engine attaches each field to the run on a file descriptor `settings.json` `attached` names (secret 3, key-id 4,
bucket 5, endpoint 6, region 7); they are read once and never printed, logged or written. A first run makes the files from the
connection's endpoint, bucket, region and key id.

The program opens no port. Each tool call is answered on a thread of its own under its own id (`src/serve/mcp.rs`), so a call
that waits (`list_changes` with `wait`) never holds back the calls after it. A caller reaches it only through the engine: tools:run
at `@tools` with `{tool: "tool:your-files", call: {name, arguments}}` sends one MCP `tools/call` to the
account's one session of the row, started by the first call (trillion-rust src/tool_runs/tools/sessions.rs `call`).

`share_file` shares a file of any size, kept as one object or in chunks, as one row of the person's own store, scope `@namespace/file-shares`, id 32
random hex digits: `{ kind, identity, name, byte_length, media_type, key_blake3, can: ["view"], published, revoked_at, expires_at, made_at }`. The key
(`shr_` and 32 random bytes, URL-safe) is made here, answered once in `<origin>/share/<id>/<key>` and never kept: only its BLAKE3 is. `stop_share {id}` sets
`revoked_at` (stopping twice answers the same); `list_shares {after?, limit?}` answers id, name, identity, expires_at and state (open, stopped, ended),
never a key. No link to the store is made: the byte route (`serve-shares`, below) serves that address. It needs `settings.json` `share.origin` (the https
address the share opens at) and is refused without it. Nothing else is needed: no records door, no other tool.

## The share byte route

`live-namespace serve-shares --state FOLDER` (`src/share_bytes`, `src/serve/shares.rs`) answers `GET` and `HEAD` at `/share/<id>/<key>` on the
loopback address `settings.json` `share_bytes.listen` names: the file's bytes, whole (200) or by one byte range (206; `bytes=a-b`, `a-`, `-n`; 416
past the end), `Accept-Ranges`, `Content-Range`, the file's media type, `Cache-Control: no-store`, `nosniff`, a `sandbox` content policy (no
script runs; a page shows its own styles and the images and media of the same address), and `inline` only for the types `inline_types` names
(every other is a download). The media type is the file's stored type (its bare type decides `inline`); a stored type that says nothing (none,
or `application/octet-stream`, as camera files from the old index carry) is read from the name's ending through `share_bytes.types_by_ending`. On every request it reads the one share row with one `get` of the person's own store, and serves only when the row's `key_blake3` is the BLAKE3
of the key (compared in constant time), it is published, not revoked, not expired and lets `view`; a long body reads the row again each
`recheck_seconds`. Nothing about a share is cached, so a share stopped with `stop_share` refuses the next request. Every refusal of a key, id or share
is the same 404; a store that does not answer is 503. Bytes are read a
`window_bytes` window at a time by range through the account files, each read through the same byte check and usage count as any read.
`share_bytes.listen` may instead be `unix:` and a socket's absolute path: a front door that sends each name's requests to the socket of
that name's own program (keep-a-caddy-front-door-on-a-computer's `each-name-its-own-folder`, `/run/sites/<name>/http.sock`) then
serves the route under its own name with no route of its own. With `share.origin` set, the route writes that address into the
person's rows as it starts (`@namespace/share-route`, id `origin`), and `share_file` in any files run whose settings name no origin
makes its links there, so no shipped settings file carries a person's address.
`on-a-computer/serve-shares.service` is the unit a computer row runs the route with (template fields: `program`, the path the
row's machine downloads keep the linux build at; `settings_file` and the row's `settings`; `descriptors`, the shell redirections
that hand each sealed credential to its descriptor, such as `3<"$CREDENTIALS_DIRECTORY/files-store-secret"`; `runtime_directory`,
`sites/<name>`; `user`, `group` (the front door's), `state`, `writable`).
A share names one file or many (`share_file` with `items`), and each item may name other files of the person's as its forms (`forms`,
such as `play`, a copy every browser plays, and `poster`): `/share/<id>/<key>/<n>` and `/share/<id>/<key>/<n>/<form>` are their bytes
by range, `?download` offers one as a download. The share's page: when the settings name `share_bytes.page` (a folder laid on the
computer; `on-a-computer/share-page` is the shipped one), a browser opening `/share/<id>/<key>` gets `page.html` filled from the share
row (each item drawn with the markup `items.json` gives its media type, escaped) and wearing the person's look (settings `site`, laid
from their own `site` row as every site of theirs wears it: `name`, `theme`, `look_css`), with its player and style from
`/share/assets/<file>`. The page runs only the address's own script files (no sandbox, no inline script, no referrer), shows one
item at a time with a strip of every item, and plays with no script at all. Each item carries `data-media-playback-*`, so a player
laid in `assets/` (the Workshop's share-view island) mounts onto it. A tool that asks for bytes (`curl`, a download manager) still
gets the first file's bytes. Tests: `tests/share_page.rs`.
The run needs what `mcp` needs and nothing more: its state folder and the attached store fields (`files-store`, `own-rows-postgres`).

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
| `tool-rows.json` | The Workshop row `tool:your-files`: the session the engine keeps open and reaches by calls (`session.calls`, the computer's own `live-namespace` program, the credentials mounted by name, `internet` for the byte store and the database, each reached through the run's proxy). |
| `kits/your-files.json` | The kit that row ships with. |
| `moved-from.json` | Each moved file's source path, commit and identities, and what was left behind. |
| `part.json` | The files the app imports from this folder. |
| `do-work/blake3.mjs`, `do-work/content-chunks-browser.mjs`, `do-work/send-a-file-to-namespace-browser.mjs` | The chunked sender the browser and folder uploaders share (moved from trillion-apps). |
| `src/main.rs` | The program: modes `mcp`, `account-files-bind`. |
| `src/serve/mod.rs` | One run: reads the attached connections, opens the rows, makes the files on a first run, `Namespace::call`. |
| `src/serve/mcp.rs` | MCP over stdio, each tool call on its own thread. |
| `src/serve/settings.rs` | Reads and checks `settings.json`. |
| `src/lib.rs` | The library. |
| `src/share_bytes/mod.rs` | The share byte route: `router`, `admit` (the whole decision about a request, read now), `stands`, `wanted` (the `Range` header), the `Grants` and `Reader` seams and `DoorGrants`. |
| `src/serve/shares.rs` | One run of `serve-shares`. |
| `src/store/` | The rows (see its README): `Rows`, `SqlStore`, `Link`, `tables.json`. |
| `src/account_files/chunk_copies.rs` | The checked copies of stored chunks kept in the state folder (`src/account_files/settings.json` `chunk_copies`), served before the store is asked (see the account files' README). |
| `src/account_files/` | The account files, moved from trillion-rust `src/account_files` (see its README). |
| `src/cause_book/` | The engine's refusal causes, which every error here carries. |
| `src/host/https.rs`, `src/host/https/settings.json` | The one HTTP client the byte store's requests go through. |
| `src/host/mcp.rs` | The MCP message bounds, `tool_answer_fits`, `InputFault`. |
| `src/host/os.rs`, `src/host/os/*.rs` | The computer under the program: owner-only files, locks, the process table. |
| `src/host/secrets.rs` | `Held`: the attached connections, the SigV4 day key, vault names. |
| `src/host/tool_runs.rs` | The computer under the program, for the usage counts' pending file. |
| `tests/account_files_common/mod.rs` | The account files over rows and a byte port in memory. |
| `tests/account_files_folder.rs`, `store_changes.rs`, `rows_in_both/` | What a native folder asks (changes, items, compare-and-set, pins, make_folder, bounds, thumbnails) and the store's change order, each in SQLite and in a real Postgres the tests start. |
| `tests/share_bytes.rs` | The route over a real loopback socket: whole, ranges, 416, HEAD, a file in several pieces, every refusal the same 404, a share stopped between two requests, the type a share is served as (stored, else by its name's ending). |
| `tests/account_files_release.rs`, `account_files_results.rs`, `account_files_route.rs`, `account_files_share.rs` | The moved tests of release, results, the tool contract and shares. |

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

**Depended on by:** `tools/live-namespace/do-work` files are imported by Trillion-X/trillion-apps (`part.json`); `tool:your-files` runs the program; tools/files-on-every-device calls `tool:your-files`.
