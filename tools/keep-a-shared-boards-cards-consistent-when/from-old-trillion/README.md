# tools/keep-a-shared-boards-cards-consistent-when/from-old-trillion/

Files of old trillion whose job is this tool's (keep a shared board's cards consistent when several people edit at once, even when the board is split across stores). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `src/space-board-partitions.mjs` | `src/space-board-partitions.mjs` | loads here |
| `test/space-board-partitions.test.mjs` | `test/space-board-partitions.test.mjs` | runs here: 8/8 pass |
