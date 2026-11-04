# tools/list-and-run-trillions-tools-for-any-ai/from-old-trillion/

Files of old trillion whose job is this tool's (list and run Trillion's tools for any AI app over the standard tool protocol, locally or on the hosted web address). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/tools.mjs` | `src/tools.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/native-collection-continuation.mjs (at the tag, not moved here yet), src/tool-listing-budget.json (at the tag, not moved here yet), src/tool-listing-budget.mjs (at the tag, not moved here yet), src/tool-behavior-notes.mjs (at the tag, not moved here yet) and 22 more |
| `test/tools-batch.test.mjs` | `test/tools-batch.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/report.mjs (at the tag, not moved here yet) |
