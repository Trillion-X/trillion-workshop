# tools/publish-the-operators-shared-records-such-as/from-old-trillion/

Files of old trillion whose job is this tool's (publish the operator's shared records, such as show rules, setup context, releases and brand, to every region, and make them current right after a deploy). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/service-records.mjs` | `src/service-records.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/service-records.json (at the tag, not moved here yet), src/resource-host.mjs (at the tag, not moved here yet) |
| `test/service-records.test.mjs` | `test/service-records.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/record-book-for-tests.mjs (at the tag, not moved here yet), test/person-store-reads-for-tests.mjs (at the tag, not moved here yet), test/kv-for-tests.mjs (at the tag, not moved here yet) |
