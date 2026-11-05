# tools/close-a-list-row-when-i-say/from-old-trillion/

Files of old trillion whose job is this tool's (close a list row when I say in my own message that I already did the thing, but only when the answer is a clear yes). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/said-done.mjs` | `src/said-done.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/said-done.json (at the tag, not moved here yet), src/brought-in.mjs (at the tag, not moved here yet), src/message-decision.mjs (at the tag, not moved here yet) |
| `test/said-done.test.mjs` | `test/said-done.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/fault/simulated-person.mjs (at the tag, not moved here yet), src/payment.mjs (at the tag, not moved here yet) |
| `src/said-done.json` | `src/said-done.json` | data, read by its module (from 5dc302be) |
