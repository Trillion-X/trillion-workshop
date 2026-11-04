# tools/keep-my-own-logins-sealed-so-i-can-always/from-old-trillion/

Files of old trillion whose job is this tool's (keep my own logins sealed so I can always see and copy them, let my AIs read only the ones I allow, and never show a value I kept private). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/saved-logins-tools.mjs` | `src/saved-logins-tools.mjs` | loads here |
| `src/saved-logins.mjs` | `src/saved-logins.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/sign-in-methods.mjs (at the tag, not moved here yet) |
| `test/saved-logins-captured-road.test.mjs` | `test/saved-logins-captured-road.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/local-store.mjs (at the tag, not moved here yet), src/inbound.mjs (at the tag, not moved here yet) |
| `test/saved-logins.test.mjs` | `test/saved-logins.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports scripts/build-crate-for-a-web-host.mjs (at the tag, not moved here yet), scripts/worker-bundle-plugins.mjs (at the tag, not moved here yet), src/root-keys.mjs (at the tag, not moved here yet), src/account-screens.mjs (at the tag, not moved here yet) and 4 more |
