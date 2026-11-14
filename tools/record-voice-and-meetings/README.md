# tools/record-voice-and-meetings

Recording a voice or a meeting: the recorder every screen uses, live words, the recordings library, meeting start and notes settings, and the screens that draw them. This table lists the files that make the two recording screens; each folder's other files are named by `moved-from.json` and the folder READMEs.

## Screens

| File | Purpose |
|------|---------|
| `show/record-screen-mount.tsx` | `tool:screen-record` as a screen module: its one export, `mount`, is the Record screen below |
| `show/record-audio-screen-mount.tsx` | `tool:screen-record-audio` as a screen module: its one export, `mount`, is the Record audio screen below |
| `web/src/workspace/record-screen.tsx` | The Record screen: record a voice memo or a video of yourself with the one recorder every screen uses and read your words as you say them; moved here byte for byte from the web client (`moved-from.json`) |
| `web/src/workspace/listen-here.tsx` | The notice on the Record screen that says which device is listening, before recording |
| `web/src/workspace/record-audio-screen.tsx` | The Record audio screen: `RecordAudioPanel` with the person's recordings, saved configurations, calendar context and meeting settings; moved here byte for byte from the web client |
| `web/src/workspace/adhoc-recording-event.ts` | The calendar event kept for an ad-hoc recording, when the meeting settings ask for one |
| `show/README.md` | The recording show files (panels, pills, recorder) |

## Files moved from bitfield-packages (packages/permission-lease)

Each file below is the package's own, byte for byte; `from-bitfield-packages/moved-from.json` names each source path and commit, the identity of its source bytes and of its bytes here, and the `calls` that made a real name or id made up. After the first commit only import paths changed. A file named `.held` is the same bytes with its test name taken off so the repository test does not run it; the reason is under `held` in the receipt. Most files import `@/packages/ui` and the retired package runtime (`@bitfield/runtime-kit`); the shared ui parts live in apps `parts/ui`, so the screens and targets here are prepared, not wired to a tool row.

| File | What it is |
|---|---|
| `read-data/capability-permission.test.ts` | A test of the package. |
