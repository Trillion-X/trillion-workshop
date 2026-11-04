# tools/record-a-job-shown-once/

"Show me once": records, for a short bounded time, what the person does on their Mac (clicks, typing, shortcuts, with the app and the control each was in) and gives it back as a draft workflow in words, which an AI keeps only after the person has looked at it. The recorder listens only: it posts, blocks and changes nothing. Text typed in a secure field is never recorded. It runs on the person's own Mac as a `computer` row.

## Files

| File | Purpose |
|------|---------|
| `do-work/demonstration-recorder.swift` | The recorder, a standalone command line: one JSON request on standard input (`{ seconds, max_events, stop_key_code }`), one JSON answer on standard output (`{ events, ended, secrets_skipped, ax_trusted }`). Without Input Monitoring it answers `ended: needs_input_monitoring` and records nothing. |
| `read-data/demonstration.mjs` | `draftFromEvents` (steps in words: typing folded, secrets never present, extra steps dropped and said), `makeDemonstrationTools`, and `record(input)`, the row's function, which runs the recorder with `/usr/bin/swift`. |
| `read-data/demonstration.json` | The recorder program, the bounds (`default_seconds`, `most_seconds`, `most_events`, `most_steps`, `text_chars`, `stop_key_code`), every step's words, the draft's shape and every word said. |
| `tool-rows.json` | `tool:record-a-demonstration`: a `computer` row with `capabilities: ["watch-the-keyboard-and-pointer"]` and a run ceiling of 330 seconds. |
| `part.json` | Nothing here is imported by other code. |
| `test/demonstration.test.mjs` | The original Trillion tests (steps in words, bounds, the missing Mac permission, an empty recording), and the real recorder on a Mac. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `draftFromEvents` | `(events, settings, { secrets }) => { id, label, job, steps, dropped_steps }` | One step per action from the DATA templates. |
| `makeDemonstrationTools` | `({ settings?, record? }) => { record(input) }` | Bounds the seconds, runs the recorder, refuses a missing Input Monitoring permission as its own state and an empty recording as try again. |

## Moved from Trillion

`computer/demonstration-recorder.swift`, `computer/demonstration.mjs` and `computer/demonstration.json` (deleted in Trillion-X/trillion dc79bb0a87), with `test/demonstration.test.mjs`. The recorder is the same file. In `demonstration.mjs`, the Mac app's own screen-permission check (Trillion `computer/drive-the-screen.json` `consent.require_grant`, with its test) is left out, because consent is now the engine's grant of the row's capability to this tool; and the process helper it imported from Trillion `computer/observe-visual.mjs` is a few lines here.

## Not yet

- The `watch-the-keyboard-and-pointer` capability is not in the engine's `computer-capabilities.json`, so a run is refused until the engine's owner adds it (its sandbox rules for starting `/usr/bin/swift` and listening to input events, and the macOS Input Monitoring and Accessibility permissions, are measured there, not here).
- The real recorder test runs only on a Mac; it was not run for this move.
- Swift compiles the recorder on every run (a few seconds); a compiled recorder would need a signing owner.

## Dependencies

**Depends on:** `tools/records-door` (`run-an-export.mjs`), Node's standard library, `/usr/bin/swift` (Xcode command line tools) on the Mac.

**Depended on by:** `tool-rows.json`. Nothing imports this folder.
