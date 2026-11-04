# tools/connect-the-original-repository-behind-an-app-edit/from-old-trillion/

Files of old trillion whose job is this tool's (connect the original repository behind an app, edit its source with revision checks and preview the rebuilt app). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/source-project-edit.mjs` | `src/source-project-edit.mjs` | loads here |
| `src/source-project-host.mjs` | `src/source-project-host.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/account-app-state.mjs (at the tag, not moved here yet), src/tool-run-call.mjs (at the tag, not moved here yet) |
| `src/source-project-preview.mjs` | `../../refresh-one-page-of-a-copied-site-from-its-original/src/source-project-preview.mjs` | home already: moved there by the src/ m–r lane (PR #159); the files here import that copy |
| `src/source-project-tools.mjs` | `src/source-project-tools.mjs` | loads here |
| `test/source-project-edit.test.mjs` | `test/source-project-edit.test.mjs` | runs here: 12/12 pass |
| `test/source-project-host.test.mjs` | `test/source-project-host.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/source-project-workshop-for-tests.mjs (at the tag, not moved here yet), src/account-app-state.mjs (at the tag, not moved here yet), src/local-store.mjs (at the tag, not moved here yet), test/app (already gone at the tag) |
| `test/source-project-preview.test.mjs` | `test/source-project-preview.test.mjs` | runs here: 5/5 pass |
| `test/source-project-tools.test.mjs` | `test/source-project-tools.test.mjs` | runs here: 3/3 pass |
