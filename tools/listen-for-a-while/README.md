# tools/listen-for-a-while/

Listens to the microphone until an end time the person gives, and writes each turn as a `heard` row as it is said. It also hears a recording another of the person's devices made the same way (`tool:hear-for-a-device`). One recorder is opened once and writes the sound in pieces back to back. Each piece is heard with `tools/audio-transcription`, each turn in it is named with `tools/know-who-is-in-this`, and the turn is written as soon as its piece has been heard. It adds no recognizer.

## Files

| File | Purpose |
|------|---------|
| `read-data/listen-for-a-while.mjs` | The tools `listenForAWhile` and `hearForADevice` (run as functions by `tools/records-door`), the one loop both go through (`hearPieces`), and the pure helpers: the end time, the recorder command, a recorder line as a piece, the `heard` rows of a piece's turns, hearing and naming by the other two tools' scripts. |
| `read-data/recording-rules.mjs` | The person's opt-in recording rules: `evaluate` (block wins, a false required fact blocks, an unknown one is pending), `mayStart`, `recheck`, the grant book, the notice step and consent events. The listener asks `evaluate` for every piece. |
| `read-data/recording-rules.json` | The words of each refusal and notice step. |
| `read-data/meeting-ledger.mjs` | What the listener says about a listening: `isFalseText` (a line that is only text a hearing model makes up out of silence), `livenessOf` (a listening whose heartbeat is older than the window reads as finished, decided when read, nothing swept) and `jobState` (a notes job's typed state in plain words with its controls). The loop leaves out a made-up stretch before it is named or written. |
| `read-data/meeting-ledger.json` | The liveness window, the made-up phrases and their word limit, and the notes-job states. |
| `read-data/leaves.json` | What listening sends off this computer and what stays on it, as rows `leavesOf` shows while their `when` tests hold. |
| `tool-rows.json` | `tool:hear-for-a-device`: a `computer` row with `start-a-program`, the files right to find and read the recording, and the same record rights as listening. `tool:listen-for-a-while`: a `computer` row with the `use-the-microphone` and `start-a-program` capabilities (the person grants the `record-and-hear` programs: ffmpeg, whisper-cli and the models folder), rights to write `heard` and `listening-voices` rows, to list `voice-print` and `recording-rule` rows, and to read the listening's `recording-facts` and `listening-switch` rows. |
| `read-data/voice-session.mjs` | `makeVoiceSession`: bounds an always-listening session. It starts on a wake phrase or `start()`, is refreshed by speech, and ends on silence, on its longest length or on a spoken dismissal. A session that is not active keeps no words. Moved from Trillion's `computer/voice-session.mjs`. |
| `read-data/voice-session.json` | The wake phrases, the idle and longest seconds, the dismissal phrases and their lead-in words, and every sentence said. |
| `read-data/hands-free.mjs` | The hands-free loop over injected parts: `makeVad` (speech cut out of a sound stream by loudness), `makeHandsFree` (each utterance heard, passed through the voice session, answered and said, never answering its own voice), `runLoop` and `wavOf`. Moved from Trillion's `computer/hands-free.mjs`, without its Mac parts (see Not yet). |
| `read-data/hands-free.json` | The capture program, the voice-activity numbers, the hearing row, the answer model's job and prompt, the play program and the mute tail, and every sentence said. |
| `test/voice-session.test.mjs` | The old app's voice-session tests, repointed to this folder. |
| `test/hands-free.test.mjs` | The old app's hands-free tests, repointed to this folder. The Mac-only REAL test stayed with the parts that were not moved. |
| `test/listen-for-a-while.test.mjs` | The loop on a fake recorder, hearing, naming and records door; the recorder reader on a fake process; pause, recording rules, the leaves list, the microphone closed when listening ends early, and a device's recording read through the door and heard as that device. |
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
| `read-data/what-was-said.mjs`, `read-data/what-was-said.json` | What happens to `heard` rows after they are written, all on the person's records: `nameHeardVoice` (`tool:name-a-heard-voice`: turns still under `Someone (voice-N)` take the enrolled person's name, the former label kept as `renamed_from`), `keepPieceSound` (keep_sound), `writeSpeakersBack` (write_back), captions (`reduceCaptions`, `applyCaptions`, `tool:caption-what-is-heard`, F-0792), the transcriber role (`roleHolder`, `mayTranscribe`, `roleRow`, F-0793), the transcript cursor (`turnsAfter`, F-0297) and the ask-time flush (`statusRow`, `waitForHearing`, F-0298); `askWhatWasSaid` (`tool:ask-what-was-said`) waits for the flush, then answers a conversation's unseen turns with the captions applied and moves its cursor. Every number and word is the JSON. |
| `ports/what-was-said.json` | Its NO_PRIOR_OWNER contract: the old code of F-0792, F-0793, F-0297 and F-0298 was deleted from old trillion (dc79bb0a) and PR #43 asked for it to be rebuilt on the listening's records; every file the code search finds is named with why it is a different job. |
| `test/what-was-said.test.mjs` | Renaming in one listening only; kept sound with each turn's place (and a real ffmpeg encode), none without keep_sound, words written when the sound cannot be kept; the speakers file beside a device's recording; caption ops; the role let go to and taken from another device; the status a piece writes and an ask that waits for it, up to its limit, and not for a listening that is not live; an ask that gives each conversation each turn once. |
| `part.json` | Nothing here is imported by other code. |

## How a run goes

- The request carries `until` (the engine takes it as UTC milliseconds next to `tool` and `input`; the same time goes in `input.until`). The recorder ends by itself `finish_seconds` (default 60) before it, so the last piece is heard, named and written and the tool returns its result before the engine ends the run: a run the engine ends is an unknown-outcome failure. The row declares a ceiling, `invoke.max_run_ms` (tool-door, 0a635ac); the engine ends the run at the earlier of `until` and the ceiling. Turning listening off is the engine cancelling the run; what was heard before is already written. A 110 second run and a four hour run are the same code.
- A `heard` row is: `listening`, `device`, `start`, `end`, `text`, `speaker` (a name, `Unsure (A or B?)` or `Someone (voice-N)`), `me`, `voice`, `score` and `unsure` when the speaker is unsure. Its id is `heard:<listening>:<start in milliseconds>`, so a piece written again changes nothing.
- The sound stays on this computer: pieces are written in the run's own folder and deleted as soon as they have been heard. Only text, names and scores are written. The `voice-print` and `listening-voices` kinds are stays_on_this_device: true.
- A listening with the same `listening` name continues the unknown voices of an earlier run of it (its `listening-voices` record), so `voice-3` stays `voice-3`.
- Pause is real. The listening's `listening-switch:<listening>` row (type `listening-switch`, `{ on, since }`) is read for every piece. While it says `on: false`, nothing said after `since` is kept, however far behind the hearing is: a piece recorded before `since` is heard without the words that start after it, the first piece recorded after it is let go unheard, and the run ends there and closes the microphone. `paused` in the answer says when.
- Recording rules are asked again for every piece, here in the capture owner: the request's `recording_rules` plus the value of every `recording-rule` row, over the facts `{ kind: "listening", device }`, the request's `recording_facts` and the listening's `recording-facts:<listening>` row. A piece recorded while they say blocked is let go unheard (`let_go`, and `blocked` says why); when they allow again, the next piece is heard. With no rules nothing is blocked.
- Every answer carries `leaves` and `stays`: what leaves this computer (the words of each turn, and the sound when keep_sound is on) and what stays on it (voice numbers, the recording while it is heard), from `read-data/leaves.json`.
- Kept sound is opt-in: with `keep_sound: { folder, keep_days? }` each piece something was kept from is compressed (AAC, by the granted ffmpeg) and written to `<folder>/<day>/<listening>-<time>.m4a` in the person's files before its rows, and each row says `sound`, `sound_from` and `sound_to` (seconds in that file) and `keep_until`. A sound that cannot be kept is said in `sound_error`; the words are still written. Without keep_sound no sound is written.
- One device hears a listening at a time (F-0793): before hearing a piece the run reads `transcriber:<listening>`; while another device's keepalive (`until`) lasts, the piece is let go and `transcriber` names that device; otherwise the run writes the role for itself, kept alive by every piece.
- Each piece writes `listening-status:<listening>`: `hearing_pending: true` before it is heard, then `false` with `heard_until` (the end of the last piece written) and a heartbeat (F-0298). `tool:ask-what-was-said` waits on it.
- `tool:hear-for-a-device` with `write_back: true` writes `<file>.speakers.json` beside the recording: each turn's start and end in seconds of the recording, who said it and the words.
- Moved from the product repo's always-on listener (`computer/listen.mjs` invariants 1c, 1d and 1e: `pausedAt`, `beforePause`, `leavesOf`, the per-piece rules check) and its rules owner (`src/recording-rules.mjs` with `src/recording-rules.json` and `test/recording-rules.test.mjs`, carried whole), and its meeting ledger (`computer/meeting-ledger.mjs` and `.json`, carried whole, with the pure assertions of `test/meeting-ledger.test.mjs`; the parts of that test that drove the Mac listener's own `listen` tool and notes job stay with that listener). The listener's own files on the Mac (the switch file, `recording-rules.json`, `recording-facts.json`) are rows here.

- A device's recording (`tool:hear-for-a-device`) is read whole through the run's door (`tools/records-door` `read-data/whole-file.mjs`) into the run's own folder, heard as one piece dated from `at`, named and written as that device's `heard` rows, and the copy is deleted. The person's file is left where it is. Moved from `computer/listen.mjs` `listeningTools.hear`; its sending to the old account's inbound route and its kept-sound cuts are the `heard` rows here.

## Moved from Trillion (browser capture)

`show/` is Trillion-X/trillion `parts/record-audio/show/live-audio-encoding.ts`, `live-audio-stream.ts` (+ `.json`) and `adaptation-ladder.ts` (+ `.json`), moved unchanged except their header paths and the one fixed endpoint address (`failover.endpoints` is now empty: the page gives its own). Their tests moved with them; the test that reads `record-in-the-browser.ts` stays in Trillion with that caller, which still imports the old copies until it moves. No row runs `show/` yet: it is the browser side of listening, loaded by the page that records.

## Not yet

- The programs are passed as input (`whisper_cli`, `ffmpeg`) as well as granted: `run-an-export.mjs` hands the function only `input`, and the grant's paths reach a run only through argv fills of `grants.start-a-program.*` (trillion-rust src/runtime/workshop/computer.rs:244). The hearing seam runs `/usr/bin/python3`; whether the Command Line Tools' Python starts inside the base sandbox is unproved.

- Cancelling the run (`tools:cancel`) kills its process group; the piece being heard at that moment is lost, and every earlier turn is already written.
- The recorder (`ffmpeg`) and `whisper-cli` must be startable by a `computer` run; the `use-the-microphone` capability carries the three audio lookups measured on 2026-10-31, but a program row for them is not proved.
- The `heard` record kind has to be declared to the record model.
- Hands-free talk (`tool:talk-hands-free` in the old app) has no row yet. Its voice session and loop are here, but the parts that ran it on the Mac are not moved. Those parts are `realParts` and `startCapture`, and the tool entry that kept one loop running between calls. They found the hearing program through `computer/keep-drive-files.mjs`, asked the Mac app's local model (`computer/local-models.mjs`) and spoke with its voice (`computer/speak.mjs`). A row would join this loop to `tools/audio-transcription` for hearing, plus an answer model and a voice, under `use-the-microphone`.
- A turn that crosses two pieces becomes two rows. Text Whisper makes up out of silence is not filtered.
- A turn that crosses two pieces becomes two rows.
- `jobState` is carried with the ledger but nothing here calls it yet: a run has no notes job. `livenessOf` reads the `listening-status` heartbeat for `tool:ask-what-was-said`.
- Who spoke is written beside a recording as a file, not as the file's own results (the account's `record_file_results`), because a run's door offers no file-results operation.
- Kept sound past `keep_until` is not moved to Recently Deleted by anything here yet (the old listener did that when listening started); the date is on every row.
- Two devices that read a free transcriber role at the same moment both hear one piece; the later role write wins and the other lets the next piece go.

## Port contract

`read-data/listen-for-a-while.mjs` has no contract in `ports/`, and the root test
`test/every-feature-file-has-a-port-contract.test.mjs` names it. The reason: it came into this repository in its
first import (37b2d55), with no receipt and no byte copy of an older owner. Its own words name one part of what it
does as moved from the product repository's `computer/listen.mjs` (`listeningTools.hear`), so NO_PRIOR_OWNER would be
false. A SOURCE_FIRST_PORT needs a first commit here that is the byte copy, and there was none, so writing one now
would be false too. The owner decides what happens next: port `computer/listen.mjs` again, byte copy first, and adapt
it until it does what this file does now; or let this repository accept a rewrite of a named owner as a mode of its
own (`ports/feature-files.json`).

## Dependencies

**Depends on:** `tools/records-door` (the door and the command that runs a function), `tools/audio-transcription`, `tools/know-who-is-in-this`, `tools/media-composition` (the models, through know-who-is-in-this); Node 22, python3, ffmpeg and whisper-cli on the computer.

**Depended on by:** nothing is imported from here. The `hold-to-it` presence check reads the `heard` rows.
