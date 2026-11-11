# tools/sync-files-between-my-computers/

Keeps a person's files in step between their computers. It says where one computer's sync stands, fills a file from another computer of the same account on the same network, and backs up a local folder into a Trillion folder. One row, `tool:say-where-file-sync-stands`, runs in a small container. LAN peers and folder bindings are library modules that whoever keeps the person's files on a computer mounts. The code is moved one to one from old trillion `computer/` (Trillion-X/trillion at `3d6dc7f9e^`, where it was deleted with the old Drive). The old Drive's hosted upstream and its fixed loopback port were not moved.

## Files

| File | Purpose |
|------|---------|
| `do-work/drive-sync-status.mjs` | `causeOf` and `driveSyncStatus`: one typed sync status record from DATA rules (moved from `computer/drive-sync-status.mjs`; its reader of the old Drive's `GET /?sync` on a fixed loopback port went with that Drive). It also holds the tool seam `sayWhereFileSyncStands(input)`, run by `tools/records-door/do-work/run-an-export.mjs`, and `settingsOf()`. |
| `do-work/lan-peers.mjs` | `createPeers`: request signing with a key derived from the account key (never the key itself), the table of known peers, signed UDP announcements and the verified whole-file fetch by BLAKE3 identity (moved from `computer/lan-peers.mjs`). |
| `do-work/folder-bindings.mjs` | `createFolderBindings`: bind a local folder to a Trillion folder under DATA constraints, send only new or changed files through the keeper's compare-and-set gate, throttle failing paths, and opt-in redirect and restore (moved from `computer/folder-bindings.mjs`). |
| `do-work/keep-a-local-file.mjs` | `keepALocalFile(input, { door })`: keeps one file (`path`, `name`, `media_type`) or a list (`files`, at most `most_files` in `keep-a-local-file.json`) from the computer into the person's Files, each through records-door's `keepLocalFile`: small files in pieces, large ones over the lease road (writeLargeFile, the Workshop's chunked sender). Refuses a link, a folder, a relative path or a bad name with its reason, and keeps the others in a list. Run by `tool:keep-a-local-file-in-my-files`. |
| `do-work/sync-files.json` | The `sync_status`, `peers` and `folder_bindings` DATA blocks, moved from `computer/trillion-drive.json` without the old Drive's listen addresses. |
| `ports/*.json` | One SOURCE_FIRST_PORT contract per moved module, naming its old trillion source and the byte-copy commit. |
| `tool-rows.json` | `tool:say-where-file-sync-stands`. |
| `part.json` | The library modules and their DATA, public to a keeper that mounts them. |
| `test/` | The old tests, moved with their assertions: `drive-sync-status.test.mjs`, `lan-peers.test.mjs`, `folder-bindings.test.mjs`. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `driveSyncStatus` | `({ rules, feed, writes }) => { state, version, network, error, moving, conflicts, failed, said }` | The first `states` row whose every condition holds is the state. A feed that was never answered is `starting`, never empty. |
| `createPeers` | `({ config, secret, selfId, now?, fetchImpl?, log? }) => { signed, verify, announce, heard, announcement, fetchWhole, live, forget }` | Off unless `peers.enabled`. A fetched file is accepted only when its BLAKE3 equals the named identity; a peer that sends anything else is cooled. |
| `createFolderBindings` | `({ ops: { entryOf, keepFile, writeRefusal }, config, file, stateDir, home, ignored? }) => { add, list, read, edit, remove, run, check, redirect, restore }` | A run only adds and updates; it never removes a Trillion name. Redirect moves the folder aside whole only after every file is proven stored. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`, `whole-file.mjs`), `tools/browse-and-upload-my-files` (the chunked sender for large files, with its wasm), `tools/content-identity`, `@noble/hashes` (BLAKE3), and Node's standard library.

**Depended on by:** `tool-rows.json`. The library modules are public in `part.json` for whoever keeps the person's files on a computer and mounts them.
