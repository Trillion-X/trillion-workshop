# tools/turn-the-decision-methods-own-sources-into-workflows/from-old-trillion/

Files of old trillion whose job is this tool's (turn the decision method's own sources into workflows that every account's AI can find and run when it designs a feature). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `scripts/method-workflows.mjs` | `scripts/method-workflows.mjs.held` | held: ERR_UNKNOWN_FILE_EXTENSION |
| `test/method-workflows.test.mjs` | `test/method-workflows.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/engine.mjs (at the tag, not moved here yet), src/local-store.mjs (at the tag, not moved here yet) |

## Still on old trillion main at 5dc302be37

Files old trillion main still held at 5dc302be37 with no copy in any new repository, moved here unchanged under their old paths by the old-trillion sweep. Nothing imports or runs them yet; adapting one into this tool is a later commit that names this receipt.

| Old path | Here |
|---|---|
| `records/method-workflows.json` | `records/method-workflows.json` |
