# tools/choose-where-shares-from-the-phone-browser/from-an-older-version/

Files of old trillion whose job is this tool's (choose where shares from the phone, browser and Android go, which AI action each site starts, and look back at what was shared before). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/share-destinations.mjs` | removed here (ported) | ported to `read-data/share-destinations.mjs`, unwired: its routes and deliver_share wait on question 16 (C-1 to C-3). Test: test/share-destination-controls.test.mjs, 9 pass. The held copy is removed in the commit that names this row. |
| `src/share-history.mjs` | removed here (ported) | ported to `read-data/share-history.mjs` in commit 3e94a853e; test/share-history.test.mjs, 5 pass. Its GET /shares route waits on question 16. |
| `src/share-starting-action.mjs` | removed here (ported) | ported to `read-data/share-starting-action.mjs` (one import path changed); test/share-starting-action.test.mjs, 4 pass. |
| `test/share-destinations.test.mjs` | `test/share-destinations.test.mjs.held` | held on question 16: 35 of its 45 cases exercise places, delivery and routes (see research row verify-every-port/remaining-held-files); its 10 others are the share-starting-action cases, the share-list cases and the workflow-action cases |

## Still on old trillion main at 5dc302be37

Files old trillion main still held at 5dc302be37 with no copy in any new repository, moved here unchanged under their old paths by the old-trillion sweep. Nothing imports or runs them yet; adapting one into this tool is a later commit that names this receipt.

| Old path | Here |
|---|---|
| `records/saved-instruction-starters.json` | `records/saved-instruction-starters.json` |
| `records/share-destination-starters.json` | `records/share-destination-starters.json` |
