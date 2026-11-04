# tools/listen-for-a-while/

Listens to the microphone until an end time the person gives, and writes each turn as a `heard` row as it is said. One recorder is opened once and writes the sound in pieces back to back. Each piece is heard with `tools/audio-transcription`, each turn in it is named with `tools/know-who-is-in-this`, and the turn is written as soon as its piece has been heard. It adds no recognizer.

## Files

| File | Purpose |
|------|---------|
| `read-data/listen-for-a-while.mjs` | The tool `listenForAWhile` (run as a function by `tools/records-door`), and the pure helpers: the end time, the recorder command, a recorder line as a piece, the `heard` rows of a piece's turns, hearing and naming by the other two tools' scripts. |
| `read-data/recording-rules.mjs` | The person's opt-in recording rules: `evaluate` (block wins, a false required fact blocks, an unknown one is pending), `mayStart`, `recheck`, the grant book, the notice step and consent events. The listener asks `evaluate` for every piece. |
| `read-data/recording-rules.json` | The words of each refusal and notice step. |
| `read-data/meeting-ledger.mjs` | What the listener says about a listening: `isFalseText` (a line that is only text a hearing model makes up out of silence), `livenessOf` (a listening whose heartbeat is older than the window reads as finished, decided when read, nothing swept) and `jobState` (a notes job's typed state in plain words with its controls). The loop leaves out a made-up stretch before it is named or written. |
| `read-data/meeting-ledger.json` | The liveness window, the made-up phrases and their word limit, and the notes-job states. |
| `read-data/leaves.json` | What listening sends off this computer and what stays on it, as rows `leavesOf` shows while their `when` tests hold. |
| `read-data/private-mode.mjs` | The opt-in private mode for a meeting or space: `available(mode, feature)` (mode off: everything; mode on: only features whose row says `private: true`, an unlisted feature is off), one plain sentence per feature, and a security code (BLAKE3 of the sorted keys, in digit groups) both sides compare out of band. |
| `read-data/private-mode.json` | Which features exist and which private mode keeps, and its words. |
| `ports/private-mode.json`, `ports/recording-rules.json` | The SOURCE_FIRST_PORT contracts for `private-mode.mjs` and `recording-rules.mjs`, both moved from the older owner. |
| `tool-rows.json` | The row `tool:listen-for-a-while`: a `computer` row with the `use-the-microphone` capability, rights to write `heard` and `listening-voices` rows, to list `voice-print` and `recording-rule` rows, and to read the listening's `recording-facts` and `listening-switch` rows. |
| `test/listen-for-a-while.test.mjs` | The loop on a fake recorder, hearing, naming and records door; the recorder reader on a fake process; pause, recording rules, the leaves list, and the microphone closed when listening ends early. |
| `test/meeting-ledger.test.mjs` | Made-up text told apart from real words, a stale heartbeat read as finished, the notes-job words, and the loop leaving a made-up stretch out. |
| `test/recording-rules.test.mjs` | The rules: open by default, block wins, pending, the mid-session recheck, grants, the notice step and consent events. |
| `show/live-audio-encoding.ts` | Microphone capture in a browser: an AudioWorklet (ScriptProcessor fallback) cuts fixed-size chunks, 16-bit PCM by default, WebCodecs Opus only when wanted, supported and accepted by the route, falling back to PCM for the rest of a recording if the encoder throws. |
| `show/live-audio-stream.ts`, `show/live-audio-stream.json` | The live-words stream that survives a dropped connection: numbered chunks in a bounded resend buffer, replay from the last confirmed turn less an overlap, a repeated line dropped by its normalised words, and the codec as DATA rows (pcm16 on; Opus, Opus with extra FEC and an Opus-plus-neural-layer row used only on the ladder's last rung, all off until the route takes them), each choice told as one structured line. |
| `show/adaptation-ladder.ts`, `show/adaptation-ladder.json` | Readings step the stream down or up one rung at a time with named events (`downgrade_once`, `recovered`, `too_low_to_downgrade`), and a failed endpoint is skipped for a persisted cooldown. The endpoints are the page's to give; none is fixed here. |
| `test/live-audio-stream.test.ts`, `test/live-audio-encoding.test.ts`, `test/adaptation-ladder.test.ts` | The original tests of the three files, assertions unchanged (vitest through `test-helpers/vitest-shim.mjs`). |
| `test/private-mode.test.mjs` | Private mode: off means everything, on keeps only what the table says and anything unlisted is off; the security code is the same for the same keys in any order and changes with one key. |
| `part.json` | Nothing here is imported by other code. |

## How a run goes

- The request carries `until` (the engine takes it as UTC milliseconds next to `tool` and `input`; the same time goes in `input.until`). The recorder ends by itself `finish_seconds` (default 60) before it, so the last piece is heard, named and written and the tool returns its result before the engine ends the run: a run the engine ends is an unknown-outcome failure. The row declares a ceiling, `invoke.max_run_ms` (tool-door, 0a635ac); the engine ends the run at the earlier of `until` and the ceiling. Turning listening off is the engine cancelling the run; what was heard before is already written. A 110 second run and a four hour run are the same code.
- A `heard` row is: `listening`, `device`, `start`, `end`, `text`, `speaker` (a name, `Unsure (A or B?)` or `Someone (voice-N)`), `me`, `voice`, `score` and `unsure` when the speaker is unsure. Its id is `heard:<listening>:<start in milliseconds>`, so a piece written again changes nothing.
- The sound stays on this computer: pieces are written in the run's own folder and deleted as soon as they have been heard. Only text, names and scores are written. The `voice-print` and `listening-voices` kinds are stays_on_this_device: true.
- A listening with the same `listening` name continues the unknown voices of an earlier run of it (its `listening-voices` record), so `voice-3` stays `voice-3`.
- Pause is real. The listening's `listening-switch:<listening>` row (type `listening-switch`, `{ on, since }`) is read for every piece. While it says `on: false`, nothing said after `since` is kept, however far behind the hearing is: a piece recorded before `since` is heard without the words that start after it, the first piece recorded after it is let go unheard, and the run ends there and closes the microphone. `paused` in the answer says when.
- Recording rules are asked again for every piece, here in the capture owner: the request's `recording_rules` plus the value of every `recording-rule` row, over the facts `{ kind: "listening", device }`, the request's `recording_facts` and the listening's `recording-facts:<listening>` row. A piece recorded while they say blocked is let go unheard (`let_go`, and `blocked` says why); when they allow again, the next piece is heard. With no rules nothing is blocked.
- Every answer carries `leaves` and `stays`: what leaves this computer (the words of each turn) and what stays on it (voice numbers, the recording while it is heard), from `read-data/leaves.json`.
- Moved from the product repo's always-on listener (`computer/listen.mjs` invariants 1c, 1d and 1e: `pausedAt`, `beforePause`, `leavesOf`, the per-piece rules check) and its rules owner (`src/recording-rules.mjs` with `src/recording-rules.json` and `test/recording-rules.test.mjs`, carried whole), and its meeting ledger (`computer/meeting-ledger.mjs` and `.json`, carried whole, with the pure assertions of `test/meeting-ledger.test.mjs`; the parts of that test that drove the Mac listener's own `listen` tool and notes job stay with that listener). The listener's own files on the Mac (the switch file, `recording-rules.json`, `recording-facts.json`) are rows here.

## Moved from Trillion (browser capture)

`show/` is Trillion-X/trillion `parts/record-audio/show/live-audio-encoding.ts`, `live-audio-stream.ts` (+ `.json`) and `adaptation-ladder.ts` (+ `.json`), moved unchanged except their header paths and the one fixed endpoint address (`failover.endpoints` is now empty: the page gives its own). Their tests moved with them; the test that reads `record-in-the-browser.ts` stays in Trillion with that caller, which still imports the old copies until it moves. No row runs `show/` yet: it is the browser side of listening, loaded by the page that records.

## Not yet

- Cancelling the run (`tools:cancel`) kills its process group; the piece being heard at that moment is lost, and every earlier turn is already written.
- The recorder (`ffmpeg`) and `whisper-cli` must be startable by a `computer` run; the `use-the-microphone` capability carries the three audio lookups measured on 2026-10-31, but a program row for them is not proved.
- The `heard` record kind has to be declared to the record model.
- A turn that crosses two pieces becomes two rows.
- `livenessOf` and `jobState` are carried with the ledger but nothing here calls them yet: a run has no heartbeat row or notes job.

## Dependencies

**Depends on:** `tools/records-door` (the door and the command that runs a function), `tools/audio-transcription`, `tools/know-who-is-in-this`, `tools/media-composition` (the models, through know-who-is-in-this); Node 22, python3, ffmpeg and whisper-cli on the computer.

**Depended on by:** nothing is imported from here. The `hold-to-it` presence check reads the `heard` rows.
