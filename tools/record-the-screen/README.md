# tools/record-the-screen/

Records one chosen display or one chosen window of the person's Mac as a movie, with pause, resume and stop, and notes the pointer beside it (positions and presses only, never keys). The recording stays in a private folder until `save` moves it to a place the person's allow-list names. It runs on the person's own Mac as a `computer` row. A second row keeps the categories of places (banking, health, social and more) that screen capture must leave out. The code was moved one to one from Trillion's Mac host (`computer/` in Trillion-X/trillion, deleted there in dc79bb0a8).

## Files

| File | Purpose |
|------|---------|
| `do-work/capture-session.mjs` | `makeCaptureSession` (start, pause, resume, stop, save, prefs, exclude, tick, status), `captureTools.capture` and `capture` (the export the row runs): the source check, the capturer ladder, the verbs, the leave-out list, the pointer sidecar and the allow-listed save. |
| `do-work/capture-display.swift` | The ScreenCaptureKit helper process: records ONE display or ONE window from the JSON config on its command line, takes `pause`, `resume` and `stop` on stdin, prints `started`, `ended` and `failed` as JSON lines, and leaves out the listed apps and window titles in the picture itself. |
| `do-work/list-capture-sources.swift` | Prints the displays and windows on this Mac now, with their frames, as JSON. |
| `do-work/track-pointer.swift` | Prints the pointer as JSON lines `{x, y, down}` at a set rate by polling the system's state; it reads no key, installs no event tap and needs no Accessibility or Input Monitoring permission. |
| `do-work/capture-shield.mjs` | Posts the two Darwin notifications around a recording so the Mac app's own windows are left out of the picture. |
| `do-work/capture-exclusion.mjs` | `categoriesOn`, `domainsIn`, `domainsOf`, `excluded`, `applyDiff`, `exclusionTools.exclusion` and `exclusion` (the export the row runs). |
| `read-data/capture-session.json` | The capturer rows in fallback order, the source kinds, the pointer settings, the save allow-list and refused roots, the shield's notification names and every word said. |
| `read-data/capture-exclusion.json` | The categories with their defaults, the seed domains, the cursor and the words. |
| `tool-rows.json` | `tool:record-the-screen` (with the `see-the-screen` capability) and `tool:places-left-out-of-screen-capture`. Both are `computer` rows run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/capture-session.test.mjs` | The session on a pretend machine (no real recording is made): source required, the ladder and its JSON config, the verbs, the leave-out list, the shield, a source going away, the pointer sidecar, the save rules, and the row. |
| `test/capture-exclusion.test.mjs` | The person's choice over the default, subdomains and look-alikes, cursor diffs and tombstones. |

## Not yet

- A recording lives in one process: `start` keeps the capturer's child process in memory, and `pause`, `resume`, `stop` and `save` reach it there. The engine runs each call of a `computer` row as a process of its own, so a `stop` sent in a later run does not find the recording a `start` began. Recording across calls needs the engine to keep one process for the row (engine work in Trillion-X/trillion-rust `src/runtime/workshop/`). Until then the rows are declared and the code is tested here; a recording is not made end to end through the engine.
- `see-the-screen` is not in the engine's `product/computer-capabilities.json` yet (see `tools/look-at-screen`), so a run of `tool:record-the-screen` is refused until the engine's owner adds it.
- The Swift helpers run only on macOS 12.3 or later with Screen Recording allowed. The tests use stand-ins and never record anyone's screen.
- The pointer sidecar was read by Trillion's `computer/auto-zoom.mjs`, which was not moved here; nothing in the Workshop reads it yet.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, and on the Mac `/usr/bin/swift` (ScreenCaptureKit, AVFoundation, AppKit), `/usr/sbin/screencapture` and `/usr/bin/notifyutil`.

**Depended on by:** nothing is imported from here.
