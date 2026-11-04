# tools/write-a-job-done-in-several-steps-have/from-old-trillion/

Files of old trillion whose job is this tool's (write a job done in several steps, have my AI, agents and tools answer each step, and keep every answer). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/workflows.mjs` | `src/workflows.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/action-completeness.mjs (at the tag, not moved here yet) |
| `test/workflows-authenticated-actors.test.mjs` | `test/workflows-authenticated-actors.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/in-process-mcp.mjs (at the tag, not moved here yet), test/agent-store-for-tests.mjs (at the tag, not moved here yet) |
| `test/workflows.test.mjs` | `test/workflows.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/in-process-mcp.mjs (at the tag, not moved here yet), scripts/workshop-rows.mjs (at the tag, not moved here yet), records/workflow-recipe-records.json (at the tag, not moved here yet), test/l078-example-run.mjs (at the tag, not moved here yet) and 3 more |
