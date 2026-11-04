# tools/invite-people-to-a-space-by-link-email-address/from-old-trillion/

Files of old trillion whose job is this tool's (invite people to a space by link, email address or phone number and show the invitation in every state it can be in). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/space-invitation.mjs` | `src/space-invitation.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/space-settings.json (at the tag, not moved here yet), src/mail-sender.mjs (at the tag, not moved here yet) |
| `test/space-invitation.test.mjs` | `test/space-invitation.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/local-store.mjs (at the tag, not moved here yet), test/source-imports-for-tests.mjs (at the tag, not moved here yet), src/mail-sender.mjs (at the tag, not moved here yet), src/invite-routes.mjs (at the tag, not moved here yet) and 7 more |
