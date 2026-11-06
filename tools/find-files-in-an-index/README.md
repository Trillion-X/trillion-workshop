# tools/find-files-in-an-index/

Find a person's files by words, name, place, kind or spoken words, in a file index that already exists on their own computer. No hosted service and no indexing: it reads the index and ranks. It runs on the person's Mac as a `computer` row holding one capability, `read-a-folder`, for the folder the index is in.

## Files

| File | Purpose |
|------|---------|
| `read-data/find-files-in-an-index.mjs` | `findFilesInAnIndex(request)`, run by `tools/records-door`'s `run-an-export.mjs`; also `readIndex`, `searchIndex` and `fuse`, and a command line (one JSON request in `argv[2]`, one JSON line out). Carried unchanged from the old package except the header comment and the default name of the identity field; `namesInIndex` and the `names` request key were added when a film's drive-lookup script moved here. |
| `tool-rows.json` | `tool:find-files-in-an-index`, a `computer` row with `capabilities: ["read-a-folder"]`, running `findFilesInAnIndexForARun`; it may read only its own `list:settings` rows (`record:setting:find-files-in-an-index~...`) through the run's records door, and packs `tools/settings` for that. |
| `part.json` | Nothing here is imported by other code. |
| `test/find-files-in-an-index.test.mjs` | The package's five tests (type gate and spoken words, a query of only type words, index and field names as request data, lane fusion, a missing index and the command line) five for `names` (exact and prefix, case, type and root, one path once, a bad list, the command line) and two for settings (a run's settings fill missing keys and lose to the request's; a settings row read through the stand-in records door, an absent or another tool's row refused), with synthetic rows, plus the row check. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `findFilesInAnIndex` | `(request) => { query, terms, intent_type, candidates_per_root, matched, hits }` | The whole tool. Request: `index_dir` and `query` or `names` (required); `index_file`, `types_file`, `type`, `root`, `limit`, `fields` (the row field for each of path, display_path, name, root, type, tags, text, identity, size), `weights`, `other_lanes` (`meaning` and `picture` hits as `{ row, score }`), `lane_weights`, `names` (file names to look up, a trailing `*` for a prefix; the answer adds `by_name` and `not_in_index`; `query` may then be left out). |
| `findFilesInAnIndexForARun` | `async (request, { door }) => answer` | The row's function: the person's settings (`settings_record`, a row of their `list:settings`, then the request's `settings`) fill every key in `SETTING_KEYS` the request leaves out (where the index is, its field names, the type and root, the weights); a key that is not one is refused. The answer adds `settings_from`. Read with `tools/settings`' `settingsFor`. |
| `namesInIndex` | `(index, request) => { by_name, not_in_index }` | Where named files are kept: exact stem (case sensitive) or `prefix*` (case insensitive), narrowed by `type` and `root`, each path once, sorted. |
| `searchIndex` | `(index, request) => ranked rows` | Recall, type gate, ranking: name above tag above path above text, adjacent-word and all-words boosts. |
| `fuse` | `(wordHits, lanes, fields, type, weights) => ranked` | Merges word, meaning and picture hits, each scaled to its own best. |
| index | JSON lines, one row per file, plus an optional types file with `type_keywords` and `stop_words` | Whatever the person's own indexer made; field names are request data. |

## Dependencies

**Depends on:** `tools/settings` (`read-data/settings.mjs`), and `tools/records-door` (`run-an-export.mjs`) and Node's standard library.

**Depended on by:** `tool-rows.json`.

## Invariants

- Read only: it never builds, embeds, transcribes or walks storage, and reads nothing outside `index_dir`.
- A typed search never returns another type; a query of only type words returns nothing.
- Absence is reported with per-root candidate counts.
- Meaning and picture hits are passed in by a caller that has those vectors; this tool does not compute them.
- Nothing in the code names a person, a drive, a kind of file or an index layout. The default field name for a file's identity is `identity`; an index that calls it something else says so in `fields`.
