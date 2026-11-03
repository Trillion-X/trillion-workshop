# tools/look-at-screen/

Takes a picture of every display on the person's Mac when, and only when, the tool is run, and gives each picture back with its exact size in pixels so an AI can point at a spot. It keeps nothing on the Mac. Learned from a screen-pointing assistant that looks only when asked (reverse engineered 2026-10-15).

## Files

| File | Purpose |
|------|---------|
| `do-work/look-at-screen.mjs` | `lookAtScreen` (run as a function by `tools/records-door`) and `look`, the same work with the system's commands handed in: asks the system whether Screen Recording is allowed, captures every display (main first), shrinks each, reads its size, and removes the folder it worked in. |
| `read-data/rules.json` | The longest edge, the picture format, the most one answer may hold, how much smaller each retry is, and the words it says. |
| `tool-rows.json` | The row `tool:look-at-screen`: a `computer` row with the `see-the-screen` capability. |
| `test/look-at-screen.test.mjs` | The behaviour on stand-in commands (no real picture is taken): displays and order, the size cap, the pointer, cleanup, access refused, the answer-size limit; and the real preflight, which takes no picture. |
| `part.json` | `do-work/look-at-screen.mjs` (with the `read-data/rules.json` it reads) is public: `tools/drive-the-screen` takes its picture with `systemCommands.capture`. |

## How a run goes

- `needs_access: "screen-recording"` with the words in `rules.words.needs_access` comes back when the system's preflight says no, or when the capture itself is refused. A blank desktop picture is never returned in its place.
- A request's `long_edge` may be smaller than the rules' `long_edge`, never larger.
- A run's answer may be at most 262144 bytes (`max_output_bytes` in the engine's `product/tool-runs.json`). The pictures are remade at `shrink_by` of the last edge until the answer fits `max_answer_bytes`, down to `least_long_edge`; if even that does not fit (many displays) the answer is an error in words, not a cut-off picture.
- Pictures are in the answer and nowhere else; the folder they are made in is removed whether the run worked or not.

## Not yet

- The `see-the-screen` capability is not in the engine's `product/computer-capabilities.json`, so a run is refused until the engine's owner adds it (its sandbox rules for `screencapture`, `sips` and `osascript`, and the macOS Screen Recording permission, are measured there, not here). The row names it; nothing here grants it.
- The run has not been proved end to end on the engine; the tests above do not take a real picture of anyone's screen.

## Dependencies

**Depends on:** `tools/records-door` (the command that runs a function), `tools/content-identity`; macOS `screencapture`, `sips` and `osascript`.

**Depended on by:** `tools/drive-the-screen` (`read-data/drive-the-screen.mjs` imports `systemCommands` for the picture its text reader reads, and its rows pack `do-work` and `read-data`).
