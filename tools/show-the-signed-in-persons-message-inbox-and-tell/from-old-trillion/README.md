# tools/show-the-signed-in-persons-message-inbox-and-tell/from-old-trillion/

Files of old trillion whose job is this tool's (show the signed-in person's message inbox and tell the sender whether the AI can be reached or will find the message later). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/work-messages.mjs` | `src/work-messages.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/typed-on-signed-in-screen.mjs (at the tag, not moved here yet) |
| `test/work-messages.test.mjs` | `test/work-messages.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/person-store.mjs (at the tag, not moved here yet), src/native-message-account-owner.mjs (at the tag, not moved here yet), src/account-action-domain.mjs (at the tag, not moved here yet), src/standalone-resource-behavior.mjs (at the tag, not moved here yet) and 8 more |
