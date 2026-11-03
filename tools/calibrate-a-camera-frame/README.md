# tools/calibrate-a-camera-frame/

Calibrates a camera's view once from four corners (detected, or guided manual corners when the detector is unsure) and maps every later point into that frame; each failed automatic attempt is handed back for training data.

Moved from Trillion-X/trillion (commit b92aa549f2) byte for byte by `tools/move-code-between-trees`: `moved-from.json` names each file's source path and commit and the identity of its bytes there and here. The tool's run (`do-work/`) calls the moved modules unchanged.

## How it runs

`tool:calibrate-a-camera-frame` run `do-work/calibrate-a-camera-frame.mjs` in a small container with no internet, through `tools/records-door/do-work/run-an-export.mjs`. It reads no records and writes nothing; everything it works on is handed in.

## What stays in the old tree

Its callers in the old tree, `parts/media-composition/do-work/cut-by-events.mjs` and `cut-the-action.mjs` (and `test/video-pipeline.test.mjs`), have not moved, so the old copy stays until they do. The segmentation, crop and colour nets and the mount types the finding names are the detector's, which this tool does not hold.

## Files

| File | Purpose |
|------|---------|
| `do-work/calibrate-a-camera-frame.mjs` | The tool's run: the input handed to the moved modules. |
| `src/frame-calibration.mjs` | `homographyFromCorners`, `toFrame`, `calibrate`: blind; the detector, the manual view and the confidence floor are the caller's. |
| `test/frame-and-stream.test.mjs` | Ported from the old tree as it was (moved by the tool). |
| `test/calibrate-a-camera-frame.test.mjs` | The run over made-up input, and each row run as the container runner runs it, on its own sample. |
| `tool-rows.json` | The Workshop rows. |
| `moved-from.json` | Where each moved file came from, and both identities. |
| `part.json` | The public files. |

## Dependencies

**Depends on:** `tools/records-door` (the run command), Node.

**Depended on by:** `tool-rows.json`.
