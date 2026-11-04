# tools/let-someone-look-at-my-trillion-read/from-old-trillion/

Files of old trillion whose job is this tool's (let someone look at my Trillion read only for a few days, exactly as I see it, with every change refused). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/view-as.mjs` | `src/view-as.mjs` | loads here |
| `test/view-as-looked.test.mjs` | `test/view-as-looked.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/local-store.mjs (at the tag, not moved here yet), test/import-source-for-tests.mjs (at the tag, not moved here yet), test/engine-tools-for-tests.mjs (at the tag, not moved here yet), src/account-control.mjs (at the tag, not moved here yet) |
| `test/view-as-owner-address.test.mjs` | `test/view-as-owner-address.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/local-store.mjs (at the tag, not moved here yet), test/import-source-for-tests.mjs (at the tag, not moved here yet), src/account-policy-name.mjs (at the tag, not moved here yet), src/account-control.mjs (at the tag, not moved here yet) |
| `test/view-as.test.mjs` | `test/view-as.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/screen-pictures.mjs (at the tag, not moved here yet) |
