# tools/show-each-setup-step-with-the-real-things-found/from-old-trillion/

Files of old trillion whose job is this tool's (show each setup step with the real things found behind it, such as which AIs, devices and sources, and what Trillion did this past week). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/setup-capability-evidence.mjs` | `src/setup-capability-evidence.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/work-results.mjs (at the tag, not moved here yet) |
| `src/setup-known.mjs` | `src/setup-known.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/setup-policy.json (at the tag, not moved here yet) |
| `src/setup-week.mjs` | `src/setup-week.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/setup-policy.json (at the tag, not moved here yet) |
| `test/setup-capability-evidence.test.mjs` | `test/setup-capability-evidence.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/activity.mjs (already gone at the tag), src/work-results.mjs (at the tag, not moved here yet) |
| `test/setup-known.test.mjs` | `test/setup-known.test.mjs.held` | held: ERR_MODULE_NOT_FOUND |
