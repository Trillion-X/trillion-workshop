# tools/drive-the-screen/

Lets the person's AIs operate the person's Mac screen. Each call looks at the screen: one app's controls from its accessibility tree, and the main display's text read from its pixels, with where each thing is. It finds the target by what it is called, does the action, looks again and says what really changed. Four tools: look, find, drive, and the list of actions. What an action is, how a target is matched and ranked, every limit and every word is DATA in `read-data/drive-the-screen.json`. Out of the box nothing stops the person's work. The person can turn on grants, allow and deny rules, observation rules, redaction, off-limits apps and guards, and take the screen over.

Moved here from `Trillion-X/trillion` `computer/drive-the-screen.mjs`, `computer/drive-the-screen.json` and `computer/screen-driver.swift` (2026-11-03), with the helpers they import.

## Files

| File | Purpose |
|------|---------|
| `read-data/drive-the-screen.mjs` | `makeScreenDriver` (observe → locate → act → observe → verify, over the programs that touch the Mac, so tests hand in a pretend one), `grantTools` (the person's grant, revoke and grants commands), and the four row entries `look`, `find`, `drive`, `actions`. Each entry is `runScreenTool`: a refusal comes back as `{ error, retry, reaction, reaction_said, outcome, code, permission }`, and `drive` asks the place `this-mac` first. Run directly it is the person's own command line (`node tools/drive-the-screen/read-data/drive-the-screen.mjs grant --actions look,press --minutes 10`). |
| `read-data/drive-the-screen.json` | The DATA: actions and their steps, element fields and ranking, keys, limits, consent, guards, off-limits classes, observation rules, secrets, reactions and words. |
| `read-data/screen-driver.swift` | The native driver, run by `/usr/bin/swift`: reads the accessibility tree, readiness, displays and Secure Input, and posts the DATA's primitive events (to the global stream, or to the app itself in the background). It has a failsafe, and a stop key the person can press. |
| `read-data/observe-visual.mjs`, `read-data/observe-visual.swift` | `run` (one program to its end) and `ocrPixels` (the text in a picture, with bounds), from Trillion's `computer/observe-visual.mjs`. |
| `read-data/helper-sandbox.mjs`, `read-data/helper-sandbox.json` | The deny-default Seatbelt profile the text reader runs under. |
| `read-data/capture-shield.mjs`, `read-data/capture-shield.json` | Brackets the capture with the Mac app's two notifications so its own windows are left out of the picture. |
| `read-data/observation-rules.mjs` | Whether an app or site may be observed at all. |
| `read-data/observation-categories.mjs`, `.json` | Lets the observation rules name a whole category of websites. |
| `read-data/run-decision.mjs`, `.json` | The decision table every look and action is judged by before any grant: the person's deny and allow lists, strict mode, managed controls and hooks. |
| `read-data/ask-payload.mjs`, `.json` | The person's redaction of what a look returns. It is off until they turn it on. |
| `read-data/settings-file.mjs` | Reads and writes a settings file the person may have edited. A file it cannot understand is never replaced with defaults. |
| `read-data/work-places.mjs`, `.json` | The places the person shares with their AIs, and their hold on them: a take-over, or their own recent input, refuses a drive. `node tools/drive-the-screen/read-data/work-places.mjs take-over this-mac 10` and `hand-back this-mac`. |
| `tool-rows.json` | `tool:look-at-the-screen`, `tool:find-on-the-screen`, `tool:drive-the-screen`, `tool:screen-actions`: `computer` rows run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/` | Trillion's tests for these files, with their assertions, repointed here, plus `tool-rows.test.mjs` for the rows. |

## How a run goes

- `look` and `find` read; `drive` reads, acts and reads again; `actions` reads only the DATA. A drive waits for the one before it, so two runs never interleave input.
- Coordinates are global points from the top left of the main display. A picture whose shape does not match the display is not placed.
- A target that moved or vanished between the look and the act is refused, never guessed. `dry_run` dispatches nothing and returns the plan.
- `verified` is true or false when `expect` is given, and null (with what changed) when it is not.
- A consent-like key in a call (`consent`, `approved`, `skip_consent` and the rest in `consent.refuse_input_keys`) is refused, whether the grant gate is on or off.
- A missing Mac permission is its own typed refusal, `code: "PERMISSION_MISSING"` with `permission` naming which one (from the DATA), separate from the person's consent.

## Not yet

- The capabilities `read-the-screen-text` and `see-the-screen` (as `tools/read-what-is-on-screen` and `tools/look-at-screen` say) and `drive-the-screen` (posting input events and accessibility actions, which needs the macOS Accessibility permission, and Input Monitoring for the stop key) are not in the engine's `product/computer-capabilities.json`, so a run is refused until the engine's owner adds them. Nothing here grants them.
- The person's state files (grants, rules, controls, approvals, taint, places, redaction preferences, observation categories) are under `~/.trillion/...` as the DATA names them, read fresh at each action. No capability yet lets a computer run read and write that folder.
- A `saved_login` reference (typing a saved login's value the AI never sees) needs a door to the account's saved logins. On the Mac host it used the account key the host held (`computer/keep-drive-files.mjs`). A computer run has no such key, so a reference is refused with `secret_refused` until the run's context carries `call`.
- The capture-shield notification names were kept in the Mac app's `macos/computer-reader.json`, which is not in `Trillion-X/trillion`. Both are null in `read-data/capture-shield.json`, so nothing is posted, and the app's own windows can appear in the picture the text is read from.
- The picture is taken by `tools/look-at-screen`'s `screencapture -x` as PNG. Trillion took it with `-m -t jpg`.
- Swift compiles the driver and the text reader on every run (a few seconds).
- The tests that run the real driver, the real text reader or the sandbox are skipped off macOS.

## Dependencies

**Depends on:** `tools/look-at-screen` (its `systemCommands.capture`), `tools/records-door` (`run-an-export.mjs`), `tools/content-identity`, `@noble/hashes` (BLAKE3 for the hand-back key); `/usr/bin/swift`, `/usr/bin/sandbox-exec`, `/usr/sbin/screencapture`, `/usr/bin/notifyutil` and `ioreg` on the Mac.

**Depended on by:** nothing is imported from here.
