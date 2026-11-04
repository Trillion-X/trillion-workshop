# tools/generate-speech/from-old-trillion/

Files of old trillion whose job is this tool's, moved here unchanged under their old paths from old trillion main at 5dc302be37 (Trillion-X/trillion), so a later adaptation starts from how old trillion did it. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt.

| Old path | Here |
|---|---|
| `records/speech-engine-records.json` | `records/speech-engine-records.json` |

## Feature files

These are old trillion's src/ and test/ files at main 5dc302be. Only import paths differ, where a file they import is already in this repository. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes).

| Old path | Here | Status |
|---|---|---|
| `src/account-speech.mjs` | `src/account-speech.mjs` | loads here (from 5dc302be) |
