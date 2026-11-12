# tools/walk-a-new-person-through-first-setup/from-old-trillion/

Files of old trillion whose job is this tool's (walk a new person through first setup: the apps to install on their devices, the AIs to connect, and one saved run that resumes where they stopped). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/setup-installs.mjs` | moved to `do-work/setup-installs.mjs` (adapted, wired into `tool-rows.json`) | ported |
| `src/setup-plan.mjs` | moved to `do-work/setup-plan.mjs` (adapted, wired into `tool-rows.json`) | ported in part; the HTTP `setupTools` surface is not carried (see `../README.md`) |
| `src/setup-runtime.mjs` | `src/setup-runtime.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/work-results.mjs (at the tag, not moved here yet) |
| `test/setup-plan.test.mjs` | `test/setup-plan.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/ai-app-guides.mjs (at the tag, not moved here yet), test/setup-fixtures.mjs (at the tag, not moved here yet) |
| `test/setup-runtime.test.mjs` | `test/setup-runtime.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/shipped-defaults.mjs (at the tag, not moved here yet), records/starting-rules.json (at the tag, not moved here yet) |
