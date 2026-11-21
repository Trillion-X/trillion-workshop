# tools/look-at-screen/

Takes a picture of every display on the person's Mac, or of one app's frontmost window, when, and only when, the tool is run, and gives each picture back with its exact size in pixels so an AI can point at a spot. It keeps nothing on the Mac. Learned from a screen-pointing assistant that looks only when asked (reverse engineered 2026-10-15).

## Files

| File | Purpose |
|------|---------|
| `do-work/look-at-screen.mjs` | `lookAtScreen` (run as a function by `tools/workflows/do-work/run-a-function.mjs`) and `look`, the same work with the system's commands handed in: asks the system whether Screen Recording is allowed, captures every display (main first), shrinks each, reads its size, and removes the folder it worked in. `pictureAnAppWindow` and `lookAtWindow` do the same for one app's frontmost on-screen window, listed through CoreGraphics by `osascript -l JavaScript` and captured by its id with `screencapture -l`. |
| `read-data/rules.json` | The longest edge, the picture format, the most one answer may hold, how much smaller each retry is, and the words it says. |
| `tool-rows.json` | The rows `tool:look-at-screen` and `tool:picture-an-app-window`: `computer` rows with the `see-the-screen` capability. |
| `kits/picture-an-app-window.json` | How a person asks for one app's window and what comes back. |
| `test/look-at-screen.test.mjs` | The behaviour on stand-in commands (no real picture is taken): displays and order, the size cap, the pointer, cleanup, access refused, the answer-size limit; one app's frontmost ordinary window by its id, no window on screen, a missing app name; and the real preflight and window list, which take no picture. |
| `part.json` | `do-work/look-at-screen.mjs` (with the `read-data/rules.json` it reads) is public: `tools/drive-the-screen` takes its picture with `systemCommands.capture`. |

## How a run goes

- `needs_access: "screen-recording"` with the words in `rules.words.needs_access` comes back when the system's preflight says no, or when the capture itself is refused. A blank desktop picture is never returned in its place.
- A request's `long_edge` may be smaller than the rules' `long_edge`, never larger.
- A run's answer may be at most 262144 bytes (`max_output_bytes` in the engine's `product/tool-runs.json`). The pictures are remade at `shrink_by` of the last edge until the answer fits `max_answer_bytes`, down to `least_long_edge`; if even that does not fit (many displays) the answer is an error in words, not a cut-off picture.
- Pictures are in the answer and nowhere else; the folder they are made in is removed whether the run worked or not.

- A window is pictured by its id, so another window covering it is not in the picture and nothing is raised to take it. Listing windows and capturing one by id need nothing beyond `see-the-screen` (measured 2026-11-21 under the engine's sandbox, crates/computer-sandbox-sbpl/computer-capabilities.json in trillion-rust).

## Not yet

- `tool:look-at-screen` has not been proved end to end on the engine; the tests above do not take a real picture of anyone's screen.

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`, the command that runs a function), `tools/content-identity`; macOS `screencapture`, `sips` and `osascript`.

**Depended on by:** `tools/drive-the-screen` (`read-data/drive-the-screen.mjs` imports `systemCommands` for the picture its text reader reads, and its rows pack `do-work` and `read-data`).
