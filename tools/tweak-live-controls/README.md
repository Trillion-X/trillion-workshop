# tools/tweak-live-controls

Only the failure contract is kept here: `failure.mjs` (`failureOf`, from old trillion `src/failure.mjs`) and the codes it reads (`failure-codes.json`, `platform-failures.json`, `effect-outcomes.json`), byte for byte from the old tree (`moved-from.json`). Two tools import them by path: `tools/shape-a-thought-into-my-content-formats/read-data/content-formats.mjs` and `tools/write-a-job-done-in-several-steps-have/read-data/workflows.mjs`. Their natural owner is `tools/say-why-a-call-failed`; they move there when those two tools' rows can be changed together.

## Files

| File | Purpose |
|------|---------|
| `failure.mjs` | The failure contract (`failureOf`), from old trillion `src/failure.mjs` |
| `failure-codes.json` | The failure codes `failure.mjs` reads |
| `platform-failures.json` | Which code a platform error is |
| `effect-outcomes.json` | What each effect state means for a retry |
| `moved-from.json` | Where each brought-in file came from, and both identities |

## Retired (Nov 18 2026)

The live controls made from a tool's input schema were retired: `made-controls.mjs`, `live-controls.mjs`, the row `tool:turn-a-tool-into-live-controls` and its kit, the Controls screen (`web/src/workspace/controls-screen.tsx`, `show/controls-mount.tsx`, `tool:screen-controls`) and its fixed list of preview kinds (`controls-previews.tsx` `PREVIEWS`, one of them `video-look`). They picked a slider, a toggle or a choice by the input's JSON type. That is a fixed list, the owner's examples turned into code.

The replacement is `tools/ui/show/run-the-screen-an-ai-wrote`. The AI writes the controls for whatever is being tuned, as code. They act on the real thing through `window.door.run`, and the screen is kept for next time.
