# tools/name-voices-from-the-call/

Names the voices of a recorded call from what the call app showed on screen, so a voice heard as "Someone (voice-2)" gets a name without anyone enrolling it. While the call runs, the caller samples the call window's accessibility elements. This tool reads which name the app showed as speaking in each sample, turns the samples into intervals shifted by the app's lag, and lays them over the unnamed voices of the recording. A voice gets a name only when the screen showed it for enough of the time that voice spoke, and each name goes to one voice only. It reads only what it is handed, clicks and types nothing, and runs on the person's own computer as a `computer` row with no capability.

## Files

| File | Purpose |
|------|---------|
| `read-data/name-from-the-call.mjs` | `rowFor`, `namesSpeaking`, `intervalsOf`, `reconcile`, `callTools.name`, and the named export `name` that `run-a-function.mjs` calls. |
| `read-data/name-from-the-call.json` | Which element field marks a speaker, how a name is cut from it, the app's lag, the label of an unnamed voice, the thresholds, the evidence sentence and every sentence said. |
| `what-this-tool-does-and-how-to-run-it.json` | `tool:name-voices-from-the-call`, a `computer` row with no capability, run by `tools/workflows`'s `run-a-function.mjs`. |
| `part.json` | Nothing here is imported by other code. |
| `test/name-from-the-call.test.mjs` | The old app's tests, repointed to this folder. |
| `test/tool-rows.test.mjs` | The row, and `apply` answering each name as a name_speaker write. |

## Key Types / Functions

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `namesSpeaking` | `(elements, row) => names` | The names the app shows as speaking, once each. |
| `intervalsOf` | `(samples, { mostGapMs, lagMs }) => [{ start_ms, end_ms, name }]` | A name lasts until the next sample or the most gap, whichever comes first, and is shifted back by the lag. |
| `reconcile` | `(turns, intervals, { sure_share, least_overlap_seconds }) => { assignments, unnamed }` | One name to one voice, only on enough evidence. Every other voice is listed with its candidates. |
| `name` | `(input) => { assignments, unnamed, writes? }` | With `apply`, answers each name as a `name_speaker` write (its arguments, evidence included) for the caller to send. |

## Moved from Trillion

`computer/name-from-the-call.mjs`, `computer/name-from-the-call.json` and `test/name-from-the-call.test.mjs` of Trillion-X/trillion (deleted there in `dc79bb0a`), moved one to one. The module imported `toolCaller` from `computer/keep-drive-files.mjs`, which is still alive there. `toolCaller` is the app's MCP client, and it carries the account key. It was used only as the fallback for `apply` when no `call` was handed in, so it is not carried. Without a `call`, `apply` is refused in words.

## Not yet

- Writing the names into the person's Trillion is not done by this run. With `apply`, the run answers `writes`; the caller (the Mac app's listening, or the person's AI) sends each one through its own `name_speaker` tool.
- The row has not been proved end to end on the engine.

## Dependencies

**Depends on:** `tools/workflows` (`run-a-function.mjs`) and Node's standard library. The samples come from the caller, for example `tools/read-what-is-on-screen`. The turns come from `tool:who-is-in-this` (`tools/know-who-is-in-this`).

**Depended on by:** `what-this-tool-does-and-how-to-run-it.json`.
