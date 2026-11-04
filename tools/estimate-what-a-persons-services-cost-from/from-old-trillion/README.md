# tools/estimate-what-a-persons-services-cost-from/from-old-trillion/

Files of old trillion whose job is this tool's (estimate what a person's services cost from measured use and listed rates, warn at a budget and stop paid work). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/spend-meter.mjs` | `src/spend-meter.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/money-out.mjs (at the tag, not moved here yet), src/cap-change.mjs (at the tag, not moved here yet) |
| `test/spend-meter.test.mjs` | `test/spend-meter.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports parts/formula-engine/rules/rule-operators.json (already gone at the tag), parts/formula-engine/rules/filter-rows-by-rules.mjs (already gone at the tag), src/metered-use.mjs (at the tag, not moved here yet), src/api-spend.mjs (at the tag, not moved here yet) and 5 more |
