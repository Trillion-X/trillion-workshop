# tools/recently-deleted-and-storage

Recently Deleted and Archived for a person's files: `namespace-set-aside.mjs`, moved from old trillion's `src/namespace-set-aside.mjs`. Deleting or archiving takes a file's or a folder's names out of the namespace and keeps them here, with when and by whom, so Put back gives every name back exactly as it was; when a state's time ends, an archived thing moves to Recently Deleted and a deleted one's names are gone for good. Nothing here deletes bytes.

## Files

| File | Purpose |
|------|---------|
| `namespace-set-aside.mjs` | `setAsideStore(sql, { keepFor, now })`: set aside, list, put back, keep-for, sweep; `hiddenAmong` for Media and search |
| `namespace-set-aside.json` | The states (Recently Deleted, Archived), their default days, what each becomes when due, the keep-for choices |
| `namespace-store.mjs`, `namespace-view.mjs` (+ `.json`), `namespace-name-counts.mjs`, `file-versions.mjs` (+ `.json`), `file-type.mjs`, `box-name.mjs`, `time-cursor.mjs`, `workspace/file-previews.json` | The person's namespace (names, folders, files) that `namespace-set-aside.mjs` takes names out of and gives back to, with what those import |
| `carry-tables-into-records.mjs` | `checkCarried`, which `keepForCarrier` uses |
| `do-work/delete-archive-and-put-back.mjs` | `deleteArchiveAndPutBack({ files, now, steps })`: the steps over files handed in, in an in-memory SQLite store (what `tool-rows.json` runs) |
| `moved-from.json` | Where each file brought in came from, with the identity of its bytes |
| `tool-rows.json` | The row `tool:delete-archive-and-put-back-my-files`, with a sample that deletes a note, archives and puts back a folder, and sweeps a month later |

Everything but `namespace-set-aside.mjs` and `do-work/` was brought in byte for byte from old trillion's `src/` at b6ae0ebf815f (4ffa1dc4a2^). The one difference is in `carry-tables-into-records.mjs`: it imports `canonical` from `../decide-with-a-method/read-data/decision-records.mjs` (line 41) instead of `./decision-store.mjs`, which defines it with the same line (line 53) but imports old trillion's record-log store, which the Workshop does not have.

## The row

`tool:delete-archive-and-put-back-my-files` runs `setAsideStore` over `namespaceStore`'s own tables, in an in-memory node:sqlite database filled with the files handed in. It keeps nothing after the run, deletes no byte, writes no file and sends nothing. Releasing storage by the person's rules stays with the screen.
