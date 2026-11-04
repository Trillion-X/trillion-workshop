# tools/publish-price-guidance-as-editable-rows/from-old-trillion/

Files of old trillion whose job is this tool's (publish price guidance as editable rows, while the offer owner still sets the real prices). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/service-price-rules.mjs` | `src/service-price-rules.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports records/service-price-rules.json (at the tag, not moved here yet), src/marketplace-content-sources.mjs (at the tag, not moved here yet) |
