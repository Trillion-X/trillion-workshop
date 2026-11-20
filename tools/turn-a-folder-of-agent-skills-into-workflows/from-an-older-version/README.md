# tools/turn-a-folder-of-agent-skills-into-workflows/from-an-older-version/

Files of old trillion whose job is this tool's (turn a folder of agent skills into workflows every account's AI can find, read and run). They are the bytes of tag `old-trillion-before-worker-retire` (b6ae0ebf81), moved here unchanged under their old paths, so they import each other as they did; only import paths differ, where a file they import is already in this repository. `../moved-from.json` names each file's source path and commit and the BLAKE3 identity of its bytes there and here. Nothing here is wired into `tool-rows.json` yet: wiring a file is adapting it into this tool's own folders and rows, in a commit that names this receipt. A file that cannot load or pass here is held: its name ends in `.held` (the same bytes), and it runs again when what it imports is here.

| Old path | Here | Status |
|---|---|---|
| `scripts/skills-to-workflows.mjs` | removed here; its bytes are at the tag (commit b6ae0ebf81, identity in `../moved-from.json`) | ported: `../read-data/skills-into-workflows.mjs` and `../data/skill-import-rules.json`. Two rulings: the sharing gate (made_here or open licence) is not a gate, since the workflows stay with the person (the port's own invariant 1); the hand-made dedupe is added to the port (`skills-into-workflows.test.mjs`, 10 pass) |
