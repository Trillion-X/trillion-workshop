# tools/tweak-live-controls

Live controls over one tool: a tool's input schema and its `controls` DATA become the rows a person moves (sliders, choices, toggles, words), and the values they move are checked against each row and the tool's own schema into the input the tool runs with. Moved from Trillion-X/trillion `src/made-controls.mjs` (a9ee258, #76); the failure contract it imports came byte for byte from the old tree (`moved-from.json`).

## Files

| File | Purpose |
|------|---------|
| `made-controls.mjs` | `controlRows`, `runInput`, `checkedValue`, `interfaceRecipe` and the old made-interface owner, unchanged from the old tree |
| `failure.mjs` | The failure contract `made-controls.mjs` imports (`failureOf`), from old trillion `src/failure.mjs` |
| `failure-codes.json` | The failure codes `failure.mjs` reads (from old trillion `src/failure-codes.json`) |
| `platform-failures.json` | Which code a platform error is (from old trillion `src/platform-failures.json`) |
| `effect-outcomes.json` | What each effect state means for a retry (from old trillion `src/effect-outcomes.json`) |
| `live-controls.mjs` | `liveControlsForATool({ descriptor, bind?, values? })`: the control rows and, given values, the checked tool input as one run (what `tool-rows.json` runs) |
| `moved-from.json` | Where each brought-in file came from, and both identities |
| `tool-rows.json` | The row `tool:turn-a-tool-into-live-controls`, with a sample run over a made-up photo-warming tool |
| `README.md` | This file |

## The row

`tool:turn-a-tool-into-live-controls` runs `live-controls.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads only what it is given and writes nothing. Running the tool, saving the interface, the preview beside the controls and undo and redo stay with the app's controls screen and the account.
