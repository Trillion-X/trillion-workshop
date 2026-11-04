# tools/measure-how-well-ai-agents-of-each-model/from-old-trillion/

Files of old trillion whose job is this tool's (measure how well AI agents of each model use Trillion's tools on plain jobs, counting steps, errors and wrong changes, and print the table). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `scripts/run-agent-tool-evals.mjs` | `scripts/run-agent-tool-evals.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports scripts/passkey-account.mjs (at the tag, not moved here yet), scripts/paid-proof-account.mjs (at the tag, not moved here yet), scripts/customer-proof-access.mjs (at the tag, not moved here yet), scripts/customer-mcp-proxy.mjs (at the tag, not moved here yet) and 2 more |
