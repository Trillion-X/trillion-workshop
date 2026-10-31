# tools/find-files-in-an-index/

Find a person's files by words, name, place, kind or spoken words, in a file index that already exists on their own computer. No hosted service and no indexing: it reads the index and ranks. It runs on the person's Mac as a `computer` row holding one capability, `read-a-folder`, for the folder the index is in.

## Files

| File | Purpose |
|------|---------|
| `read-data/find-files-in-an-index.mjs` | `findFilesInAnIndex(request)`, run by `tools/records-door`'s `run-an-export.mjs`; also `readIndex`, `searchIndex` and `fuse`, and a command line (one JSON request in `argv[2]`, one JSON line out). Carried unchanged from the old package except the header comment and the default name of the identity field. |
| `tool-rows.json` | `tool:find-files-in-an-index`, a `computer` row with `capabilities: ["read-a-folder"]`. |
| `part.json` | Nothing here is imported by other code. |
| `test/find-files-in-an-index.test.mjs` | The package's five tests (type gate and spoken words, a query of only type words, index and field names as request data, lane fusion, a missing index and the command line) with synthetic rows, plus the row check. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `findFilesInAnIndex` | `(request) => { query, terms, intent_type, candidates_per_root, matched, hits }` | The whole tool. Request: `index_dir`, `query` (required); `index_file`, `types_file`, `type`, `root`, `limit`, `fields` (the row field for each of path, display_path, name, root, type, tags, text, identity, size), `weights`, `other_lanes` (`meaning` and `picture` hits as `{ row, score }`), `lane_weights`. |
| `searchIndex` | `(index, request) => ranked rows` | Recall, type gate, ranking: name above tag above path above text, adjacent-word and all-words boosts. |
| `fuse` | `(wordHits, lanes, fields, type, weights) => ranked` | Merges word, meaning and picture hits, each scaled to its own best. |
| index | JSON lines, one row per file, plus an optional types file with `type_keywords` and `stop_words` | Whatever the person's own indexer made; field names are request data. |

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`) and Node's standard library.

**Depended on by:** `tool-rows.json`.

## Invariants

- Read only: it never builds, embeds, transcribes or walks storage, and reads nothing outside `index_dir`.
- A typed search never returns another type; a query of only type words returns nothing.
- Absence is reported with per-root candidate counts.
- Meaning and picture hits are passed in by a caller that has those vectors; this tool does not compute them.
- Nothing in the code names a person, a drive, a kind of file or an index layout. The default field name for a file's identity is `identity`; an index that calls it something else says so in `fields`.
