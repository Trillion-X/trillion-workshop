# tools/list-the-ais-in-a-shared-space-for-its-members-and-hand/from-old-trillion/

Files of old trillion whose job is this tool's (list the AIs in a shared space for its members, and hand an AI working there what members said most recently). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/space-ais.mjs` | `src/space-ais.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/account-routes.mjs (at the tag, not moved here yet), src/ai-reach.mjs (at the tag, not moved here yet) |
| `test/space-ais-native.test.mjs` | `test/space-ais-native.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/shared-native-host-for-tests.mjs (at the tag, not moved here yet), src/native-shared-request-admission.mjs (at the tag, not moved here yet), src/ai-reach.mjs (at the tag, not moved here yet) |
