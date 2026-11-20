# tools/media-composition/from-an-older-version/

Files of old trillion whose job is this tool's, moved here unchanged under their old paths from old trillion main at 5dc302be37 (Trillion-X/trillion), so a later adaptation starts from how old trillion did it. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt.

| Old path | Here |
|---|---|
| `test/relink-editor-projects.test.mjs` | `test/relink-editor-projects.test.mjs` (the old file whole, beside the adapted `../test/relink-editor-projects.test.mjs`, which has no case for the row and licence the old file checks; it reads `records/workshop-tool-records.json` at `tools/connect-a-service-and-seal-its-key/from-an-older-version/records/`) |

Superseded: the two records files that stood here are declared rows now, so their files are removed. The make-style rows (13) are in `tool-rows.json` from commit b400e9a2b, and the picture rows (generate and edit) from commit 3991cf859. Their content is in git history at the commit before each removal.
