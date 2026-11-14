# tools/media-composition/from-old-trillion/

Files of old trillion whose job is this tool's, moved here unchanged under their old paths from old trillion main at 5dc302be37 (Trillion-X/trillion), so a later adaptation starts from how old trillion did it. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt.

| Old path | Here |
|---|---|
| `records/workshop-media-generation-tool-records.json` | `records/workshop-media-generation-tool-records.json` |
| `records/workshop-tool-records.json` (the two local image rows only, `tool:generate-local-image` and `tool:edit-local-image`) | `records/workshop-local-image-tool-records.json` (the rest of that old file stays in `../../connect-a-service-and-seal-its-key/from-old-trillion/records/`) |
| `test/relink-editor-projects.test.mjs` | `test/relink-editor-projects.test.mjs` (the old file whole, beside the adapted `../test/relink-editor-projects.test.mjs`, which has no case for the row and licence the old file checks; it reads `records/workshop-tool-records.json` at `tools/connect-a-service-and-seal-its-key/from-old-trillion/records/`) |
