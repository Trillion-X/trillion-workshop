# tools/listen-for-a-while/

Listens to the microphone until an end time the person gives, and writes each turn as a `heard` row as it is said. One recorder is opened once and writes the sound in pieces back to back. Each piece is heard with `tools/audio-transcription`, each turn in it is named with `tools/know-who-is-in-this`, and the turn is written as soon as its piece has been heard. It adds no recognizer.

## Files

| File | Purpose |
|------|---------|
| `read-data/listen-for-a-while.mjs` | The tool `listenForAWhile` (run as a function by `tools/records-door`), and the pure helpers: the end time, the recorder command, a recorder line as a piece, the `heard` rows of a piece's turns, hearing and naming by the other two tools' scripts. |
| `read-data/recording-rules.mjs` | The person's opt-in recording rules: `evaluate` (block wins, a false required fact blocks, an unknown one is pending), `mayStart`, `recheck`, the grant book, the notice step and consent events. The listener asks `evaluate` for every piece. |
| `read-data/recording-rules.json` | The words of each refusal and notice step. |
| `read-data/leaves.json` | What listening sends off this computer and what stays on it, as rows `leavesOf` shows while their `when` tests hold. |
| `tool-rows.json` | The row `tool:listen-for-a-while`: a `computer` row with the `use-the-microphone` capability, rights to write `heard` and `listening-voices` rows, to list `voice-print` and `recording-rule` rows, and to read the listening's `recording-facts` and `listening-switch` rows. |
| `read-data/voice-session.mjs` | `makeVoiceSession`: bounds an always-listening session. It starts on a wake phrase or `start()`, is refreshed by speech, and ends on silence, on its longest length or on a spoken dismissal. A session that is not active keeps no words. Moved from Trillion's `computer/voice-session.mjs`. |
| `read-data/voice-session.json` | The wake phrases, the idle and longest seconds, the dismissal phrases and their lead-in words, and every sentence said. |
| `read-data/hands-free.mjs` | The hands-free loop over injected parts: `makeVad` (speech cut out of a sound stream by loudness), `makeHandsFree` (each utterance heard, passed through the voice session, answered and said, never answering its own voice), `runLoop` and `wavOf`. Moved from Trillion's `computer/hands-free.mjs`, without its Mac parts (see Not yet). |
| `read-data/hands-free.json` | The capture program, the voice-activity numbers, the hearing row, the answer model's job and prompt, the play program and the mute tail, and every sentence said. |
| `test/voice-session.test.mjs` | The old app's voice-session tests, repointed to this folder. |
| `test/hands-free.test.mjs` | The old app's hands-free tests, repointed to this folder. The Mac-only REAL test stayed with the parts that were not moved. |
| `test/listen-for-a-while.test.mjs` | The loop on a fake recorder, hearing, naming and records door; the recorder reader on a fake process; pause, recording rules, the leaves list, and the microphone closed when listening ends early. |
| `test/recording-rules.test.mjs` | The rules: open by default, block wins, pending, the mid-session recheck, grants, the notice step and consent events. |
| `part.json` | Nothing here is imported by other code. |

## How a run goes

- The request carries `until` (the engine takes it as UTC milliseconds next to `tool` and `input`; the same time goes in `input.until`). The recorder ends by itself `finish_seconds` (default 60) before it, so the last piece is heard, named and written and the tool returns its result before the engine ends the run: a run the engine ends is an unknown-outcome failure. The row declares a ceiling, `invoke.max_run_ms` (tool-door, 0a635ac); the engine ends the run at the earlier of `until` and the ceiling. Turning listening off is the engine cancelling the run; what was heard before is already written. A 110 second run and a four hour run are the same code.
- A `heard` row is: `listening`, `device`, `start`, `end`, `text`, `speaker` (a name, `Unsure (A or B?)` or `Someone (voice-N)`), `me`, `voice`, `score` and `unsure` when the speaker is unsure. Its id is `heard:<listening>:<start in milliseconds>`, so a piece written again changes nothing.
- The sound stays on this computer: pieces are written in the run's own folder and deleted as soon as they have been heard. Only text, names and scores are written. The `voice-print` and `listening-voices` kinds are stays_on_this_device: true.
- A listening with the same `listening` name continues the unknown voices of an earlier run of it (its `listening-voices` record), so `voice-3` stays `voice-3`.
- Pause is real. The listening's `listening-switch:<listening>` row (type `listening-switch`, `{ on, since }`) is read for every piece. While it says `on: false`, nothing said after `since` is kept, however far behind the hearing is: a piece recorded before `since` is heard without the words that start after it, the first piece recorded after it is let go unheard, and the run ends there and closes the microphone. `paused` in the answer says when.
- Recording rules are asked again for every piece, here in the capture owner: the request's `recording_rules` plus the value of every `recording-rule` row, over the facts `{ kind: "listening", device }`, the request's `recording_facts` and the listening's `recording-facts:<listening>` row. A piece recorded while they say blocked is let go unheard (`let_go`, and `blocked` says why); when they allow again, the next piece is heard. With no rules nothing is blocked.
- Every answer carries `leaves` and `stays`: what leaves this computer (the words of each turn) and what stays on it (voice numbers, the recording while it is heard), from `read-data/leaves.json`.
- Moved from the product repo's always-on listener (`computer/listen.mjs` invariants 1c, 1d and 1e: `pausedAt`, `beforePause`, `leavesOf`, the per-piece rules check) and its rules owner (`src/recording-rules.mjs` with `src/recording-rules.json` and `test/recording-rules.test.mjs`, carried whole). The listener's own files on the Mac (the switch file, `recording-rules.json`, `recording-facts.json`) are rows here.

## Not yet

- Cancelling the run (`tools:cancel`) kills its process group; the piece being heard at that moment is lost, and every earlier turn is already written.
- The recorder (`ffmpeg`) and `whisper-cli` must be startable by a `computer` run; the `use-the-microphone` capability carries the three audio lookups measured on 2026-10-31, but a program row for them is not proved.
- The `heard` record kind has to be declared to the record model.
- Hands-free talk (`tool:talk-hands-free` in the old app) has no row yet. Its voice session and loop are here, but the parts that ran it on the Mac are not moved. Those parts are `realParts` and `startCapture`, and the tool entry that kept one loop running between calls. They found the hearing program through `computer/keep-drive-files.mjs`, asked the Mac app's local model (`computer/local-models.mjs`) and spoke with its voice (`computer/speak.mjs`). A row would join this loop to `tools/audio-transcription` for hearing, plus an answer model and a voice, under `use-the-microphone`.
- A turn that crosses two pieces becomes two rows. Text Whisper makes up out of silence is not filtered.

## Dependencies

**Depends on:** `tools/records-door` (the door and the command that runs a function), `tools/audio-transcription`, `tools/know-who-is-in-this`, `tools/media-composition` (the models, through know-who-is-in-this); Node 22, python3, ffmpeg and whisper-cli on the computer.

**Depended on by:** nothing is imported from here. The `hold-to-it` presence check reads the `heard` rows.
