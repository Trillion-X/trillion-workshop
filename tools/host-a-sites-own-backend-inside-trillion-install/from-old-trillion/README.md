# tools/host-a-sites-own-backend-inside-trillion-install/from-old-trillion/

Files of old trillion whose job is this tool's (host a site's own backend inside Trillion: install its code, give it a private database and serve its files). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/site-worker-assets.mjs` | `src/site-worker-assets.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/public-app-file-store.mjs (at the tag, not moved here yet) |
| `src/site-worker-installation.mjs` | `src/site-worker-installation.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/public-app-file-store.mjs (at the tag, not moved here yet), src/resource-host.mjs (at the tag, not moved here yet), src/public-app-visitor-call.mjs (at the tag, not moved here yet) |
| `src/site-worker-runtime.mjs` | `src/site-worker-runtime.mjs` | loads here |
| `src/site-worker-source.mjs` | `src/site-worker-source.mjs` | loads here |
| `test/site-worker-installation.test.mjs` | `test/site-worker-installation.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/public-app-file-store.mjs (at the tag, not moved here yet), test/src/site-worker-runtime.mjs (already gone at the tag) |
| `test/site-worker-source.test.mjs` | `test/site-worker-source.test.mjs` | runs here: 3/3 pass |
