# tools/check-that-everything-waiting-on-a-person-reaches-them/from-old-trillion/

Files of old trillion whose job is this tool's. They are old trillion's bytes at main 5dc302be, moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into this tool's rows yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes).

| Old path | Here | Status |
|---|---|---|
| `src/steps-ais-leave-runs.mjs` | `src/steps-ais-leave-runs.mjs` | loads here (from 5dc302be) |
| `src/steps-ais-leave.mjs` | `src/steps-ais-leave.mjs.held` | held: imports src/steps-ais-leave.json, which stays in old trillion until a real person's name in it is replaced with a made-up one (from 5dc302be) |
| `test/steps-ais-leave-runs.test.mjs` | `test/steps-ais-leave-runs.test.mjs.held` | held: imports src/steps-ais-leave.mjs (held) (from 5dc302be) |
| `test/steps-ais-leave.test.mjs` | `test/steps-ais-leave.test.mjs.held` | held: imports src/steps-ais-leave.mjs (held) (from 5dc302be) |
