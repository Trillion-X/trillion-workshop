# parts/device-copy

A person's records kept on their own device: the same record store (`parts/record-log`) over SQLite compiled to WebAssembly, so a browser or an iPhone web view holds a working copy that survives reloads, reads in microseconds and keeps working offline, settling with the hosted copy through `parts/record-log/do-work/record-sync.mjs`.

## Files

| File | Purpose |
|------|---------|
| `part.json` | Which files other code may import (`do-work/wasm-sqlite-host.mjs`, `do-work/device-copy-worker.mjs`) |
| `do-work/wasm-sqlite-host.mjs` | The record store's SQL seam (`exec(query, ...params) → { toArray, one }`, nested `transaction`) over an open sqlite-wasm database, with the same 100-bound-values refusal a Durable Object makes; `openDeviceDatabase` keeps the file in the browser's private file system (the SAH pool file system) inside a dedicated worker, in memory anywhere else |
| `do-work/device-copy-worker.mjs` | The worker a page starts: opens the person's copy in the private file system and answers the page's messages (read, ids, find, settle, state, and the sealed-record calls: sealing, unlock, lock, seal, unseal, open_sealed, find_sealed, with the sealing key kept only in the worker's memory); a settle sends bounded, replay-safe batches to the hosted store and keeps the copy's position in the copy itself |
| `do-work/account-copy.mjs` | Account-specific browser database locations and authenticated sync transport; authorization refusals close access and abort pending requests |
| `do-work/frame-compression.mjs` + `do-work/frame-dictionaries.json` | A settle upload compressed (deflate) against a sample of settle JSON in DATA, the sample named by its BLAKE3 hash in the frame headers; `compressFrame(text)` → `{ body, headers }` or null (send plain), `expandFrame(body, headers, { max_expanded_bytes })` expands only to the size the frame declared and refuses a frame with no size, an unknown dictionary, a wrong size or too many bytes. `account-copy.mjs` sends large batches this way and `src/browser-record-copy.mjs` `browserRecordCopyBody` reads them for `/work/records/settle`; a plain post is still read |
| `do-work/pack-a-settle-upload.mjs` | `packSettleUpload({ account, request })`: where one account's copy is kept and the exact upload one settle batch would be (frame or plain, headers, sizes, body), with nothing opened or sent (what `tool-rows.json` runs) |
| `tool-rows.json` | The row `tool:pack-my-device-copys-settle-upload`, with a sample run whose twelve-note batch goes as a compressed frame |
| `moved-from.json` | Where `do-work/frame-compression.mjs` came from (old trillion `parts/device-copy/`, byte for byte) |
| `README.md` | This file |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `wasmSqliteHost(db)` | `(sqlite3.oo1.DB) → { db, sql, transaction, close }` | The seam over any open sqlite-wasm database; prepared statements reused per text |
| `openDeviceDatabase(sqlite3, { name, directory })` | `→ Promise<{ kept: 'device' \| 'memory', db, sql, transaction, close }>` | The device's database: the private file system when the SAH pool can be installed (a dedicated worker), else memory |
| worker messages | `{ id, call: 'open' \| 'read' \| 'ids' \| 'find' \| 'settle' \| 'state' \| 'sealing' \| 'unlock' \| 'lock' \| 'seal' \| 'unseal' \| 'open_sealed' \| 'find_sealed', args }` → `{ id, result \| error }` | What a page asks its copy |

## Dependencies

**Depends on:** `@sqlite.org/sqlite-wasm` (Apache-2.0), `parts/record-log` (the store and `record-sync.mjs`), `parts/sealed-records` (`sealed-copy.mjs`, the worker's sealed-record calls).

**Depended on by:** `scripts/build-workspace.mjs` (builds the worker as `device-copy-worker.js` with its `sqlite3.wasm`), `src/workspace/device-copy.ts` (the page's handle on its copy), `test/wasm-sqlite-host.test.mjs`, `test/record-sync.test.mjs`.

## Invariants

1. One store implementation on every host: this part adds a SQL seam, never a second store.
2. The copy keeps its own position (`took_through`, `sent_through`) in its own database, so a reload or a lost page never resends or retakes what it already settled.
3. Nothing here names a record kind, a person or a device kind.
4. Browser workers require an account for opening and every subsequent message. Records, positions, copy IDs and sealing metadata stay within its directory; the old unbound directory is retained for recovery and never imported. The server checks each sync's initiating account against the current cookie before accepting records. Page termination drops access and keys while preserving account-specific disk copies.
