# tools/show-a-visitor-who-is-not-signed-in-the-same/from-old-trillion/

Files of old trillion whose job is this tool's (show a visitor who is not signed in the same price every time, and keep that price once they sign in). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/visitor-mark.mjs` | `src/visitor-mark.mjs` | loads here |
| `src/visitor-offers.mjs` | `src/visitor-offers.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/payment.mjs (at the tag, not moved here yet), src/plan-comparison.mjs (at the tag, not moved here yet), parts/http-client/do-work/same-origin.mjs (already gone at the tag) |
| `test/visitor-offers.test.mjs` | `test/visitor-offers.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/payment.mjs (at the tag, not moved here yet), records/service-price-experiments.json (at the tag, not moved here yet) |
