# tools/read-public-repositories-of-agent-skills-and-offer/from-old-trillion/

Files of old trillion whose job is this tool's (read public repositories of agent skills and offer each skill as a Marketplace workflow). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/skill-rows.mjs` | `src/skill-rows.mjs.held` | held: ERR_UNKNOWN_FILE_EXTENSION |
| `src/skill-source-config.mjs` | `src/skill-source-config.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports records/skill-sources.json (at the tag, not moved here yet), src/marketplace-content-sources.mjs (at the tag, not moved here yet), records/skill-import-rules.json (at the tag, not moved here yet) |
| `src/skill-sources.mjs` | `src/skill-sources.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/database-resource-composition.mjs (at the tag, not moved here yet) |
| `test/skill-sources-root.test.mjs` | `test/skill-sources-root.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports records/skill-sources.json (at the tag, not moved here yet), records/skill-import-rules.json (at the tag, not moved here yet) |
| `test/skill-sources.test.mjs` | `test/skill-sources.test.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports test/in-process-mcp.mjs (at the tag, not moved here yet), records/skill-sources.json (at the tag, not moved here yet), records/skill-import-rules.json (at the tag, not moved here yet) |

## Still on old trillion main at 5dc302be37

Files old trillion main still held at 5dc302be37 with no copy in any new repository, moved here unchanged under their old paths by the old-trillion sweep. Nothing imports or runs them yet; adapting one into this tool is a later commit that names this receipt.

| Old path | Here |
|---|---|
| `records/skill-import-rules.json` | `records/skill-import-rules.json` |
| `records/skill-sources.json` | `records/skill-sources.json` |
