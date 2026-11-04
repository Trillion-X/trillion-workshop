# tools/keep-each-workshop-task-whole-and-a-small-index/from-old-trillion/

Files of old trillion whose job is this tool's (keep each Workshop task whole and a small index of every task for fast questions across all of them). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/workshop-tasks.mjs` | `src/workshop-tasks.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/record-history.mjs (at the tag, not moved here yet), src/reliability-ceilings.json (at the tag, not moved here yet) |
| `test/workshop-tasks-bounded.test.mjs` | `test/workshop-tasks-bounded.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/person-store-reads-for-tests.mjs (at the tag, not moved here yet) |
| `test/workshop-tasks-for-tests.mjs` | `test/workshop-tasks-for-tests.mjs.held` | held: ERR_MODULE_NOT_FOUND |
