# tools/write-a-workshop-tasks-history-to-a-file-and-read/from-old-trillion/

Files of old trillion whose job is this tool's (write a Workshop task's history to a file and read it back whole, even a row too big for the file limit, in exact byte pieces). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/workshop-history-serialization.mjs` | `src/workshop-history-serialization.mjs` | loads here |
| `src/workshop-task-history.mjs` | `src/workshop-task-history.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/record-history.mjs (at the tag, not moved here yet) |
| `test/workshop-history-serialization.test.mjs` | `test/workshop-history-serialization.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/local-store.mjs (at the tag, not moved here yet) |
