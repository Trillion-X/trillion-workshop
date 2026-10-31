# tools/listen-for-a-while/

Listens to the microphone until an end time the person gives, and writes each turn as a `heard` row as it is said. One recorder is opened once and writes the sound in pieces back to back. Each piece is heard with `tools/audio-transcription`, each turn in it is named with `tools/know-who-is-in-this`, and the turn is written as soon as its piece has been heard. It adds no recognizer.

## Files

| File | Purpose |
|------|---------|
| `read-data/listen-for-a-while.mjs` | The tool `listenForAWhile` (run as a function by `tools/records-door`), and the pure helpers: the end time, the recorder command, a recorder line as a piece, the `heard` rows of a piece's turns, hearing and naming by the other two tools' scripts. |
| `tool-rows.json` | The row `tool:listen-for-a-while`: a `computer` row with the `use-the-microphone` capability, rights to write `heard` and `listening-voices` rows and to list `voice-print` rows. |
| `test/listen-for-a-while.test.mjs` | The loop on a fake recorder, hearing, naming and records door; the recorder reader on a fake process. |
| `part.json` | Nothing here is imported by other code. |

## How a run goes

- The request carries `until` (the engine takes it as UTC milliseconds next to `tool` and `input`; the same time goes in `input.until`). The recorder ends by itself `finish_seconds` (default 60) before it, so the last piece is heard, named and written and the tool returns its result before the engine ends the run: a run the engine ends is an unknown-outcome failure. The row declares a ceiling, `invoke.max_run_ms` (tool-door, 0a635ac); the engine ends the run at the earlier of `until` and the ceiling. Turning listening off is the engine cancelling the run; what was heard before is already written. A 110 second run and a four hour run are the same code.
- A `heard` row is: `listening`, `device`, `start`, `end`, `text`, `speaker` (a name, `Unsure (A or B?)` or `Someone (voice-N)`), `me`, `voice`, `score` and `unsure` when the speaker is unsure. Its id is `heard:<listening>:<start in milliseconds>`, so a piece written again changes nothing.
- The sound stays on this computer: pieces are written in the run's own folder and deleted as soon as they have been heard. Only text, names and scores are written. The `voice-print` and `listening-voices` kinds are stays_on_this_device: true.
- A listening with the same `listening` name continues the unknown voices of an earlier run of it (its `listening-voices` record), so `voice-3` stays `voice-3`.

## Not yet

- Cancelling the run (`tools:cancel`) kills its process group; the piece being heard at that moment is lost, and every earlier turn is already written.
- The recorder (`ffmpeg`) and `whisper-cli` must be startable by a `computer` run; the `use-the-microphone` capability carries the three audio lookups measured on 2026-10-31, but a program row for them is not proved.
- The `heard` record kind has to be declared to the record model.
- A turn that crosses two pieces becomes two rows. Text Whisper makes up out of silence is not filtered.

## Dependencies

**Depends on:** `tools/records-door` (the door and the command that runs a function), `tools/audio-transcription`, `tools/know-who-is-in-this`, `tools/media-composition` (the models, through know-who-is-in-this); Node 22, python3, ffmpeg and whisper-cli on the computer.

**Depended on by:** nothing is imported from here. The `hold-to-it` presence check reads the `heard` rows.
