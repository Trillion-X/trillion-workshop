# tools/give-shared-tasks-to-people-and-ais-keep/from-old-trillion/

Files of old trillion whose job is this tool's (give shared tasks to people and AIs, keep an order and dependencies between them, and cap how many one AI works at once). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/space-assignment-delivery.mjs` | `src/space-assignment-delivery.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/space-assignment-delivery.json (at the tag, not moved here yet) |
| `src/space-task-command-owner.mjs` | `src/space-task-command-owner.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/resource-host.mjs (at the tag, not moved here yet) |
| `src/space-task-shard-query.mjs` | `src/space-task-shard-query.mjs` | loads here |
| `test/space-task-shard-query.test.mjs` | `test/space-task-shard-query.test.mjs` | runs here: 2/2 pass |
