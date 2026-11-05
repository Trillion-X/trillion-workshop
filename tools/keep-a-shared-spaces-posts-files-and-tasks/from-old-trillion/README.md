# tools/keep-a-shared-spaces-posts-files-and-tasks/from-old-trillion/

Files of old trillion whose job is this tool's (keep a shared space's posts, files and tasks in separate stores so a busy space never slows another, and read them back merged in order). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/space-commit-context.mjs` | `src/space-commit-context.mjs` | loads here |
| `src/space-content-coordination.mjs` | `src/space-content-coordination.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/shared-native-dependency-command.mjs (at the tag, not moved here yet), src/shared-native-execution-context.mjs (at the tag, not moved here yet), src/resource-host.mjs (at the tag, not moved here yet) |
| `src/space-content-directory.mjs` | `src/space-content-directory.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/shared-native-dependency-command.mjs (at the tag, not moved here yet), src/resource-host.mjs (at the tag, not moved here yet) |
| `src/space-content-policy.mjs` | `src/space-content-policy.mjs` | loads here |
| `src/space-content-shards.mjs` | `src/space-content-shards.mjs` | loads here |
| `src/space-list-read.mjs` | `src/space-list-read.mjs` | loads here |
| `src/space-page-size.mjs` | `src/space-page-size.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/space-settings.json (at the tag, not moved here yet) |
| `src/space-shard-routing.mjs` | `src/space-shard-routing.mjs.held` | held: ERR_MODULE_NOT_FOUND; imports src/native-shared-source-query.mjs (at the tag, not moved here yet), src/shared-native-dependency-command.mjs (at the tag, not moved here yet), src/community-activity.mjs (at the tag, not moved here yet) |
| `test/space-commit-context.test.mjs` | `test/space-commit-context.test.mjs` | runs here: 5/5 pass |
| `test/space-content-policy.test.mjs` | `test/space-content-policy.test.mjs` | runs here: 9/9 pass |
| `src/space-item-rules.mjs` | `src/space-item-rules.mjs` | loads here (from 5dc302be) |
| `src/space-mail.json` | `src/space-mail.json` | data, read by its module (from 5dc302be) |
| `src/space-mail.mjs` | `src/space-mail.mjs` | loads here (from 5dc302be) |
