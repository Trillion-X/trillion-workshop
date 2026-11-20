# tools/media-composition/from-an-older-version/

Files of old trillion whose job is this tool's, moved here unchanged under their old paths from old trillion main at 5dc302be37 (Trillion-X/trillion), so a later adaptation starts from how old trillion did it. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt.

The table is empty: the old relink test is ported. Its row and licence case are the last test in `../test/relink-editor-projects.test.mjs`, which reads the row from `../records.json` and the licence from `../../../licence-classes.json`, so the old file (which read a connect-a-service records file) is removed. Its content is in git history at the commit before that removal.

Superseded: the two records files that stood here are declared rows now, so their files are removed. The make-style rows (13) are in `tool-rows.json` from commit b400e9a2b, and the picture rows (generate and edit) from commit 3991cf859. Their content is in git history at the commit before each removal.
