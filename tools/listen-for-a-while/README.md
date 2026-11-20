# tools/listen-for-a-while/

Listens to the microphone until an end time the person gives, and answers each turn as a `heard` row. It also hears a recording another of the person's devices made the same way (`tool:hear-for-a-device`). One recorder is opened once and writes the sound in pieces back to back. Each piece is heard with `tools/audio-transcription` and each turn in it is named with `tools/know-who-is-in-this`. It adds no recognizer. **No tool in this folder keeps anything**: each takes what it needs in its request (the person's AI reads rows from a store's own tool server) and returns its result in its answer (the person's AI keeps it where it chooses).

## Files

| File | Purpose |
|------|---------|
| `read-data/listen-for-a-while.mjs` | The tools `listenForAWhile` and `hearForADevice` (run as functions by `tools/workflows/do-work/run-a-function.mjs`; the second hears the one recording whose bytes are handed in as `stored.files`), the one loop both go through (`hearPieces`), and the pure helpers: the end time, the recorder command, a recorder line as a piece, the `heard` rows of a piece's turns, hearing and naming by the other two tools' scripts. |
| `read-data/recording-rules.mjs` | The person's opt-in recording rules: `evaluate` (block wins, a false required fact blocks, an unknown one is pending), `mayStart`, `recheck`, the grant book, the notice step and consent events. The listener asks `evaluate` for every piece. |
| `read-data/recording-rules.json` | The words of each refusal and notice step. |
| `read-data/meeting-ledger.mjs` | What the listener says about a listening: `isFalseText` (a line that is only text a hearing model makes up out of silence) and `jobState` (a notes job's typed state in plain words with its controls). The loop leaves out a made-up stretch before it is named. |
| `read-data/meeting-ledger.json` | The made-up phrases and their word limit, and the notes-job states. |
| `read-data/leaves.json` | What listening sends off this computer and what stays on it, as rows `leavesOf` shows while their `when` tests hold. |
| `tool-rows.json` | `tool:hear-for-a-device`: a `computer` row with `start-a-program`; the recording's bytes come in as `stored.files`, and it holds no files or record right. `tool:listen-for-a-while`: a `computer` row with the `use-the-microphone` and `start-a-program` capabilities (the person grants the `record-and-hear` programs: ffmpeg, whisper-cli and the models folder) and no door at all. `tool:name-a-heard-voice`, `tool:caption-what-is-heard` and `tool:ask-what-was-said`: `computer` rows with no door; the heard rows, captions and cursor are request fields. |
| `read-data/voice-session.mjs` | `makeVoiceSession`: bounds an always-listening session. It starts on a wake phrase or `start()`, is refreshed by speech, and ends on silence, on its longest length or on a spoken dismissal. A session that is not active keeps no words. Moved from Trillion's `computer/voice-session.mjs`. |
| `read-data/voice-session.json` | The wake phrases, the idle and longest seconds, the dismissal phrases and their lead-in words, and every sentence said. |
| `read-data/hands-free.mjs` | The hands-free loop over injected parts: `makeVad` (speech cut out of a sound stream by loudness), `makeHandsFree` (each utterance heard, passed through the voice session, answered and said, never answering its own voice), `runLoop` and `wavOf`. Moved from Trillion's `computer/hands-free.mjs`, without its Mac parts (see Not yet). |
| `read-data/hands-free.json` | The capture program, the voice-activity numbers, the hearing row, the answer model's job and prompt, the play program and the mute tail, and every sentence said. |
| `test/voice-session.test.mjs` | The old app's voice-session tests, repointed to this folder. |
| `test/hands-free.test.mjs` | The old app's hands-free tests, repointed to this folder. The Mac-only REAL test stayed with the parts that were not moved. |
| `test/listen-for-a-while.test.mjs` | The loop on a fake recorder, hearing and naming with no door handed to the run (the answer holds the turns); the recorder reader on a fake process; pause, recording rules, the leaves list, the microphone closed when listening ends early, and a device's recording read through the files door and heard as that device. |
| `read-data/private-mode.mjs` | The opt-in private mode for a meeting or space: `available(mode, feature)` (mode off: everything; mode on: only features whose row says `private: true`, an unlisted feature is off), one plain sentence per feature, and a security code (BLAKE3 of the sorted keys, in digit groups) both sides compare out of band. |
| `read-data/private-mode.json` | Which features exist and which private mode keeps, and its words. |
| `ports/private-mode.json`, `ports/recording-rules.json` | The SOURCE_FIRST_PORT contracts for `private-mode.mjs` and `recording-rules.mjs`, both moved from the older owner. |
| `test/meeting-ledger.test.mjs` | Made-up text told apart from real words, a stale heartbeat read as finished, the notes-job words, and the loop leaving a made-up stretch out. |
| `test/recording-rules.test.mjs` | The rules: open by default, block wins, pending, the mid-session recheck, grants, the notice step and consent events. |
| `show/live-audio-encoding.ts` | Microphone capture in a browser: an AudioWorklet (ScriptProcessor fallback) cuts fixed-size chunks, 16-bit PCM by default, WebCodecs Opus only when wanted, supported and accepted by the route, falling back to PCM for the rest of a recording if the encoder throws. |
| `show/live-audio-stream.ts`, `show/live-audio-stream.json` | The live-words stream that survives a dropped connection: numbered chunks in a bounded resend buffer, replay from the last confirmed turn less an overlap, a repeated line dropped by its normalised words, and the codec as DATA rows (pcm16 on; Opus, Opus with extra FEC and an Opus-plus-neural-layer row used only on the ladder's last rung, all off until the route takes them), each choice told as one structured line. |
| `show/adaptation-ladder.ts`, `show/adaptation-ladder.json` | Readings step the stream down or up one rung at a time with named events (`downgrade_once`, `recovered`, `too_low_to_downgrade`), and a failed endpoint is skipped for a persisted cooldown. The endpoints are the page's to give; none is fixed here. |
| `test/live-audio-stream.test.ts`, `test/live-audio-encoding.test.ts`, `test/adaptation-ladder.test.ts` | The original tests of the three files, assertions unchanged (vitest through `test-helpers/vitest-shim.mjs`). |
| `test/private-mode.test.mjs` | Private mode: off means everything, on keeps only what the table says and anything unlisted is off; the security code is the same for the same keys in any order and changes with one key. |
| `read-data/what-was-said.mjs`, `read-data/what-was-said.json` | What is done with `heard` rows handed in, all from the request to the answer: `nameHeardVoice` (`tool:name-a-heard-voice`: turns still under `Someone (voice-N)` take the enrolled person's name, the former label kept as `renamed_from`; the answer holds the renamed rows), captions (`reduceCaptions`, `applyCaptions`, `tool:caption-what-is-heard`, F-0792; the answer holds the new captions state), the transcriber role (`roleHolder`, `mayTranscribe`, F-0793; the role is `{ device, until }` in the request) and the transcript cursor (`turnsAfter`, F-0297); `askWhatWasSaid` (`tool:ask-what-was-said`) answers the turns after the cursor handed in, with the captions applied, and the cursor to hand in next. Every number and word is the JSON. |
| `ports/what-was-said.json` | Its NO_PRIOR_OWNER contract: the old code of F-0792, F-0793 and F-0297 was deleted from old trillion (dc79bb0a); every file the code search finds is named with why it is a different job. |
| `test/what-was-said.test.mjs` | Renaming in one listening only (the answer holds the renamed rows, the rows handed in are untouched); caption ops and the captions state carried by the answer; the role let go to and taken from another device; an ask that gives each conversation each turn once from the cursor it hands in. Every tool runs with no records door. |
| `read-data/hearing-sources.mjs`, `read-data/hearing-sources.json` | One hearing pass per source (the microphone and the Mac's sound are never mixed before they are heard), words back in time order labelled by their source row, `me` from the row, and a session record with a BLAKE3 content id that refuses secret-looking flags and keeps the last `most_sessions`. Ported from the old `computer/hearing-sources.mjs` (`b7dc53d08a`). |
| `test/hearing-sources.test.mjs` | The three old assertions of `hearing-sources`, against the ported module. |
| `test/hear-method.test.mjs` | The hear step on an injected hearer: one pass per source, the hearing options reach the hearer, the session names the hearer, an empty request is refused. |
| `records/workshop-listening-tool-records.json` | The old listening records (kept as they were). Ten of its tool ids have owners in other tools; `people-listening-can-name`, `voice-for` and `speak` have no current tool row yet. |
| `records/from-the-older-repository.moved-from.json` | Where the old listening files came from (source commit and the deleting commit). |
| `part.json` | Nothing here is imported by other code. |

## How a run goes

- The request carries `until` (the engine takes it as UTC milliseconds next to `tool` and `input`; the same time goes in `input.until`). The recorder ends by itself `finish_seconds` (default 60) before it, so the last piece is heard and named and the tool answers before the engine ends the run: a run the engine ends is an unknown-outcome failure. The row declares a ceiling, `invoke.max_run_ms` (tool-door, 0a635ac); the engine ends the run at the earlier of `until` and the ceiling. A run the engine cancels answers nothing, so the person's AI asks for the stretch it wants in `until` (and pauses with `listening_switch`). A 110 second run and a four hour run are the same code.
- A `heard` row is: `listening`, `device`, `start`, `end`, `text`, `speaker` (a name, `Unsure (A or B?)` or `Someone (voice-N)`), `me`, `voice`, `score` and `unsure` when the speaker is unsure. Its id is `heard:<listening>:<start in milliseconds>` in the answer's `heard` list, so a piece heard again gives the same id.
- The sound stays on this computer: pieces are written in the run's own folder and deleted as soon as they have been heard. Only text, names and scores are in the answer; the sound is never kept anywhere. The `voice-print` and `listening-voices` kinds are stays_on_this_device: true.
- A listening continues the unknown voices of an earlier run of it when the answer's `voice_session` is handed back as `voice_session`, so `voice-3` stays `voice-3`. The enrolled voices come in as `voice_prints` (the person's `voice-print` rows, read by their AI).
- Pause is real. The request's `listening_switch` (`{ on, since }`) is read for every piece. While it says `on: false`, nothing said after `since` is kept, however far behind the hearing is: a piece recorded before `since` is heard without the words that start after it, the first piece recorded after it is let go unheard, and the run ends there and closes the microphone. `paused` in the answer says when.
- Recording rules are asked for every piece, here in the capture owner: the request's `recording_rules`, over the facts `{ kind: "listening", device }` and the request's `recording_facts`. A piece recorded while they say blocked is let go unheard (`let_go`, and `blocked` says why). With no rules nothing is blocked.
- Every answer carries `leaves` and `stays`: what leaves this computer (the words of each turn, in the answer) and what stays on it (voice numbers, the recording while it is heard), from `read-data/leaves.json`.
- One device hears a listening at a time (F-0793): while the request's `transcriber` role (`{ device, until }`) belongs to another device and its `until` has not passed, the piece is let go and `transcriber` names that device.
- Moved from the product repo's always-on listener (`computer/listen.mjs` invariants 1c, 1d and 1e: `pausedAt`, `beforePause`, `leavesOf`, the per-piece rules check) and its rules owner (`src/recording-rules.mjs` with `src/recording-rules.json` and `test/recording-rules.test.mjs`, carried whole), and its meeting ledger (`computer/meeting-ledger.mjs` and `.json`, carried whole, with the pure assertions of `test/meeting-ledger.test.mjs`; the parts of that test that drove the Mac listener's own `listen` tool and notes job stay with that listener). The listener's own files on the Mac (the switch file, `recording-rules.json`, `recording-facts.json`) are rows here.

- A device's recording (`tool:hear-for-a-device`) is handed in whole as its bytes in `stored.files` (the most is `read-data/hear-a-file.json`) and written into the run's own folder, heard as one piece dated from `at`, named and answered as that device's `heard` rows, and the copy is deleted. The person's file is left where it is. Moved from `computer/listen.mjs` `listeningTools.hear`.

## Moved from Trillion (browser capture)

`show/` is Trillion-X/trillion `tools/record-audio/show/live-audio-encoding.ts`, `live-audio-stream.ts` (+ `.json`) and `adaptation-ladder.ts` (+ `.json`), moved unchanged except their header paths and the one fixed endpoint address (`failover.endpoints` is now empty: the page gives its own). Their tests moved with them; the test that reads `record-in-the-browser.ts` stays in Trillion with that caller, which still imports the old copies until it moves. No row runs `show/` yet: it is the browser side of listening, loaded by the page that records.

## Not yet

- The programs are passed as input (`whisper_cli`, `ffmpeg`) as well as granted: `run-a-function.mjs` hands the function only `input`, and the grant's paths reach a run only through argv fills of `grants.start-a-program.*` (trillion-rust src/runtime/workshop/computer.rs:244). The hearing seam runs `/usr/bin/python3`; whether the Command Line Tools' Python starts inside the base sandbox is unproved.

- Cancelling the run (`tools:cancel`) kills its process group; nothing is answered, so what was heard in that run is lost.
- The recorder (`ffmpeg`) and `whisper-cli` must be startable by a `computer` run; the `use-the-microphone` capability carries the three audio lookups measured on 2026-10-31, but a program row for them is not proved.
- Hands-free talk (`tool:talk-hands-free` in the old app) has no row yet. Its voice session and loop are here, but the parts that ran it on the Mac are not moved. Those parts are `realParts` and `startCapture`, and the tool entry that kept one loop running between calls. They found the hearing program through `computer/keep-drive-files.mjs`, asked the Mac app's local model (`computer/local-models.mjs`) and spoke with its voice (`computer/speak.mjs`). A row would join this loop to `tools/audio-transcription` for hearing, plus an answer model and a voice, under `use-the-microphone`.
- A turn that crosses two pieces becomes two rows. Text Whisper makes up out of silence is not filtered.
- A turn that crosses two pieces becomes two rows.
- `jobState` is carried with the ledger but nothing here calls it yet: a run has no notes job.
- The hear step of `hearing-sources` is wired to audio-transcription's hearer (`hearFile`, `tools/audio-transcription/read-data/hear-here.mjs:63`) as `hearSourcesOfACall`. The old step picked a program from `computer-sources.json` rows through `hearWith` in `keep-drive-files.mjs`, which is no longer on origin/main; the current hearer takes its model from the caller's `hearing` options instead. Not run here: a real hear needs a local model. Tests use an injected hearer.
- Two devices handed a free transcriber role at the same moment both hear one piece; the person's AI hands the role to one.

## Port contract

The first import mixed adaptation with implementation; it was not an exact byte-copy baseline. The repair keeps
that history intact. Commit `8889fe2f` separately preserved the exact voice-loop and session sources, the pause and
disclosure functions, the transcriber-role slice and the bounded hearing wait (the wait has since been deleted with the status row it read). Commit `24c156d5` preserved the exact
transcript-cursor filter. The fresh `*-core.mjs` files came afterwards and are claimed by their own source-first
contracts. The inactive `.held` files supply history evidence only, never active retention or executable behavior.

The original `hands-free.mjs` and `voice-session.mjs` paths now forward their exports to those cores. The bounded
listener imports the old pause/disclosure functions. The heard-turn functions use the old role predicate and sequence
filter over the rows and role handed in; they preserve strict expiry and original row bindings. The existing behavior tests and the source-seam tests exercise those consumers.

The adapter contract is limited to the bounded invocation and the heard-row representation seam. It does not
claim that microphone listening, the old always-on disk-outbox listener, caption-source sentence assembly, role
liveness or cursor filtering had no older owner. Person-authored caption edits beside heard rows remain
distinct from the older caption-source open/insert/delete/close assembler. This source work does not establish an
installed microphone run or native-program eligibility.

## Dependencies

**Depends on:** `tools/workflows` (`do-work/run-a-function.mjs`, the command that runs a function), `tools/audio-transcription`, `tools/know-who-is-in-this`, `tools/media-composition` (the models, through know-who-is-in-this); Node 22, python3, ffmpeg and whisper-cli on the computer.

**Depended on by:** nothing is imported from here. The `hold-to-it` presence check reads the `heard` rows.
