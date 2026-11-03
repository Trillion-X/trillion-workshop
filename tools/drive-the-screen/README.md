# tools/drive-the-screen/

Drives the person's Mac screen for their AIs. One call observes (the accessibility tree of one running app, and a picture of the main display read as text with where each line is), finds a target by what it is called (never by coordinates), does an action, observes again and says what really changed. It runs on the person's own Mac as four `computer` rows: look, find, drive and the action list. What an action is, how a thing is found and ranked, every limit and every word is DATA in `read-data/drive-the-screen.json`.

Moved from Trillion-X/trillion `computer/drive-the-screen.mjs`, `computer/drive-the-screen.json` and `computer/screen-driver.swift`, with the helpers they import and their tests (2026-11-03). The code moved one to one; what changed is listed under "What changed in the move".

## Files

| File | Purpose |
|------|---------|
| `read-data/drive-the-screen.mjs` | The driver (`makeScreenDriver`: look, find, drive, actions over the programs that touch the Mac, so tests hold a pretend one), the person's grants (`grantTools`), and the four functions the rows run: `lookAtTheScreen`, `findOnTheScreen`, `driveTheScreen`, `screenActions` (over `makeScreenTools`). Run directly, it is the person's own command line: grant, revoke, grants, allow, deny, unallow, undeny, strict, rules, propose. |
| `read-data/drive-the-screen.json` | Every action as a row of primitive steps, the element fields and ranking, consent, guards, limits, keys, the plan sentences, reactions, the capture, and every word said. |
| `read-data/screen-driver.swift` | The native program: `read` lists the displays and one app's accessibility tree, with readiness (Accessibility, Screen Recording, a locked screen, Secure Input); `act` runs primitive events in order (pointer, keys, text, paste, accessibility actions, captions), watches the person's stop key and corner failsafe, and posts to one process in the background when asked. |
| `read-data/observe-visual.mjs`, `read-data/observe-visual.swift` | `ocrPixels`: the picture's text with normalized bounds and the picture's own size, from Vision; `run`: one program to its end. |
| `read-data/capture-shield.mjs`, `read-data/capture-shield.json` | Brackets the picture with the two notifications the Trillion Mac app listens for, so its own windows are left out. |
| `read-data/observation-rules.mjs` | Whether an app or a website may be observed at all (defaults and rows from the DATA's `observation`). |
| `read-data/observation-categories.mjs`, `.json` | Lets those rules name a whole kind of website; the table ships empty. |
| `read-data/run-decision.mjs`, `.json` | The one decision table for whether an action may run in an app: the person's deny and allow lists, an organisation's, strict, and the person's own hooks. Nothing is on by default. |
| `read-data/ask-payload.mjs`, `.json` | The person's redaction of what the AI reads off the screen, off until they turn it on. |
| `read-data/settings-file.mjs` | The one way a settings file the person may have edited is read and written: a file that cannot be understood is never replaced by defaults. |
| `read-data/work-places.mjs`, `.json` | The person's hold on this Mac: they take it over (AIs refused until they hand it back or the take-over ends) and their own recent keyboard or pointer input holds it for a few seconds. Run directly, it is their command line: take-over, hand-back. |
| `tool-rows.json` | `tool:look-at-the-screen`, `tool:find-on-the-screen`, `tool:drive-the-screen`, `tool:screen-actions`: `computer` rows run by `tools/records-door`'s `run-an-export.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/` | The original tests from Trillion-X/trillion, repointed to these paths with their assertions: 16 files, 55 tests. The tests that start the real Swift programs run only on macOS. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `makeScreenDriver` | `({ settings?, home?, now?, program?, capture?, ocr?, wait?, readSecret?, parent? }) => { look, find, drive, actions }` | The driver. Each refusal is an error with its words, `status`, `reaction` (retry, ask_user, use_different_tool, stop), `retry`, and `outcome: unknown` when the action may have run. |
| `makeScreenTools` | `({ settings?, driver?, places?, scratch? }) => { look, find, drive, actions }` | What the Mac host did around these rows: takes `settings_folder` from the input as the driver's home, asks the place `this-mac` before a drive and marks when it ends, carries `told` after a hand-back, and answers a refusal as `{ error, retry, retry_after_ms, reaction, reaction_said, outcome, code, permission }` instead of throwing (run-an-export prints only a thrown error's message). |
| `lookAtTheScreen`, `findOnTheScreen`, `driveTheScreen`, `screenActions` | `(input, { door }) => answer` | The four functions the rows name. |
| `grantTools` | `(settings?, { home?, now? }) => { grant, revoke, grants, known }` | The person's grants, written to their own file; never a Workshop tool. |
| `makePlaces` | `({ settings?, home?, now?, exec?, key? }) => { take_over, hand_back, handsOn, acted }` | The person's hold on a place. |

## How a run goes

- `settings_folder` is the folder the person keeps their screen-driving settings in: the folder that holds `.trillion/screen-driving` (grants, rules, controls, approvals, taint), `.trillion/work-places` and `.trillion/capture`, as their home folder did on the Mac host. Left out, the run starts from a fresh empty folder, so only the shipped DATA applies: out of the box nothing is limited (no grant gate, no rules, every guard off).
- The person's own command lines run against the same folder: `HOME=<folder> node tools/drive-the-screen/read-data/drive-the-screen.mjs grant --actions press --minutes 10`, and `HOME=<folder> node tools/drive-the-screen/read-data/work-places.mjs take-over this-mac 15`.
- Look and find read; drive observes, finds, acts, observes again and verifies, one drive at a time within a run; a rehearsal (`dry_run`) dispatches nothing and returns the plan in sentences.
- `tool:screen-actions` reads only the DATA and asks for no capability.

## What changed in the move

- **The Mac host's wiring** (`computer/mac-tools.mjs runHere` and its rows in `computer/mac-tools.json`) is gone. What it did for these rows is in `makeScreenTools`: the place check before a drive (its `place: "this-mac"`), the words `not_an_object` and `failed` (now `host_words` in the DATA), and passing a refusal's reaction, retry and outcome on. The host's worker isolation (`isolate`, `computer/isolated-run.mjs`) is replaced by the engine's own run and its `max_run_ms`.
- **Settings under `~/.trillion`** are read from the run's `settings_folder` instead of the home folder; the paths inside it are unchanged.
- **The picture** is taken by `tools/look-at-screen` (`systemCommands.capture` with one file: the main display, no sound, no pointer, PNG). The DATA's `capture.program` and `capture.args` (`screencapture -x -m -t jpg`) are gone; `capture.file` names the picture.
- **The capture shield's names** were read from `macos/computer-reader.json`, which left Trillion-X/trillion when the apps moved to Trillion-X/trillion-apps, so on Trillion's main every look that read pixels failed with ENOENT. They are in `read-data/capture-shield.json`, taken from that file as it was before the move.
- **The text reader** was started under the host's own Seatbelt profile (`computer/helper-sandbox.mjs`, row `image-text`); a computer run is already started deny-default by the engine, so it is started as itself.
- **Saved logins**: a `saved_login` reference was read with the account key the Mac host held (`computer/keep-drive-files.mjs toolCaller`). A computer run holds no account key, so a reference is refused in words (`secret_refused`) until the engine hands runs a way to read one. Tests hand in their own reader.
- **Tests**: paths repointed; `runHere(...)` calls became the `makeScreenTools` functions with the same assertions (one assertion, that the host row named `place: "this-mac"`, has no row left to read); the confidence-filter file keeps only its screen-driver test (`test/drive-the-screen-abstain.test.mjs`), the rest stays with `src/confidence-filter.mjs` in Trillion; one fixture's macOS-only `/private/tmp` became the system's temporary folder.

## Not yet

- The capabilities `see-the-screen` (Screen Recording, `screencapture`), `read-the-screen-text` (Accessibility, `/usr/bin/swift`) and `drive-the-screen` (posting input events, Input Monitoring for the stop key, `ioreg` for the person's idle time, the capture-shield notifications) are not in the engine's `src/runtime/workshop/computer-capabilities.json` (Trillion-X/trillion-rust), so look, find and drive are refused until the engine's owner adds them. `change-a-folder` is listed there.
- `settings_folder` is taken from the input. A run can reach only a folder the person granted as change-a-folder, but an AI could name an empty granted folder and so not see the person's deny lists; the engine should hand the run the granted folder itself (the task's `grants`) instead.
- Saved logins (above).
- `run-decision.json`'s `before_tool_run` hook step was asked by the Mac host before every tool; no computer run asks it.
- Nothing here has been proved end to end on the engine; the tests above use a pretend Mac except the macOS-only ones.

## Dependencies

**Depends on:** `tools/look-at-screen` (`do-work/look-at-screen.mjs` `systemCommands.capture`), `tools/records-door` (`run-an-export.mjs`), `tools/content-identity`, `@noble/hashes` (BLAKE3 of the hand-back key); macOS `/usr/bin/swift`, `screencapture`, `notifyutil` and `ioreg`.

**Depended on by:** `tool-rows.json`.
