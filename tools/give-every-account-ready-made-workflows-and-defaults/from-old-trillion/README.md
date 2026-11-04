# tools/give-every-account-ready-made-workflows-and-defaults/from-old-trillion/

Files of old trillion whose job is this tool's (give every account ready made workflows and defaults, and keep only the changes the person makes to them). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/shipped-workflows.mjs` | `src/shipped-workflows.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/execution-modes.mjs (at the tag, not moved here yet), records/workflow-recipe-records.json (at the tag, not moved here yet), records/setup-workflow-records.json (at the tag, not moved here yet) |
