# tools/suggest-zooms-from-pointer-moves/

Turns the pointer moves and clicks noted beside a screen recording into zoom suggestions: where the pointer settled, for how long, and how strong a zoom that asks for (a click makes it one step stronger). The suggestions are plain rows the person can edit before the video is exported, and the compositor's flags for them come from the same settings. It runs on the person's own computer as a `computer` row that asks for no capability: the telemetry is given whole.

## Files

| File | Purpose |
|------|---------|
| `read-data/auto-zoom.mjs` | `suggestZooms` (the one dwell and click detector), `exportFlags`, and `suggest(input)`, the row's function. |
| `read-data/auto-zoom.json` | The sample step, `least_ms`, `most_ms`, `radius`, `merge_gap_ms`, the strength `bands`, the zoom `levels` and the compositor's `export_flags`. |
| `tool-rows.json` | `tool:suggest-zooms`: a `computer` row with `capabilities: []`, run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/auto-zoom.test.mjs` | The original Trillion tests, and the sidecar-beside-a-recording test from Trillion's `test/capture-session.test.mjs` (its zoom half). |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `suggestZooms` | `({ space, samples }, settings) => [{ start_ms, end_ms, x, y, strength, zoom, clicks }]` | Refuses telemetry not in `normalized-source`, so a zoom can never point at the wrong place. Deterministic, sorted, none overlapping. |
| `exportFlags` | `(settings, file, zooms) => string[]` | The compositor's command-line words with `{file}` and `{zooms}` filled. |
| `suggest` | `({ sidecar } \| { recording }) => { zooms }` | The row's function. |

## Moved from Trillion

`computer/auto-zoom.mjs` and `computer/auto-zoom.json` (deleted in Trillion-X/trillion dc79bb0a87), with `test/auto-zoom.test.mjs`. The code is the same.

## Not yet

- The row offers `sidecar` only. `suggest` still reads a `<recording>.pointer.json` beside a recording when given `recording`, as Trillion's capture session (deleted with it) wrote; offering that through the row would need a `read-a-folder` grant on the recording's folder, and no Workshop capture writes that file yet.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library.

**Depended on by:** `tool-rows.json`. Nothing imports this folder.
