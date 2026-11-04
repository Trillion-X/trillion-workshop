# tools/let-a-visitor-try-trillions-own-workspace-live/from-old-trillion/

Files of old trillion whose job is this tool's (let a visitor try Trillion's own workspace live in a throwaway account that empties itself when its time ends). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/showcase-spare-facts.mjs` | `src/showcase-spare-facts.mjs` | loads here |
| `src/showcases.mjs` | `src/showcases.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/html-page.mjs (at the tag, not moved here yet) |
| `test/showcases.test.mjs` | `test/showcases.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/import-source-for-tests.mjs (at the tag, not moved here yet), src/local-store.mjs (at the tag, not moved here yet), test/src/showcases.mjs (already gone at the tag), test/src/tours.mjs (already gone at the tag) and 3 more |
