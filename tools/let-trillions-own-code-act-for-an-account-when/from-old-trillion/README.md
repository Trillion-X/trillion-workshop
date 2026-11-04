# tools/let-trillions-own-code-act-for-an-account-when/from-old-trillion/

Files of old trillion whose job is this tool's (let Trillion's own code act for an account when no person is signed in, with a short-lived proof only the account's own policy can make). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/service-actor.mjs` | `src/service-actor.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/resource-host.mjs (at the tag, not moved here yet) |
| `test/service-actor-derived-key.test.mjs` | `test/service-actor-derived-key.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/native-own-records-for-tests.mjs (at the tag, not moved here yet) |
| `test/service-actor-operation-gate.test.mjs` | `test/service-actor-operation-gate.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/own-resource-request.mjs (at the tag, not moved here yet), test/native-own-records-for-tests.mjs (at the tag, not moved here yet) |
| `test/service-actor.test.mjs` | `test/service-actor.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/local-store.mjs (at the tag, not moved here yet), src/account-control-state.mjs (at the tag, not moved here yet), src/ai-reach.mjs (at the tag, not moved here yet), src/ (already gone at the tag) |
