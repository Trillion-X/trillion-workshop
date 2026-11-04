# Record Audio Show

React surface files for recording or importing audio.

## Rules

- `browser-media-capture.ts` is the package-facing wrapper over `permission-lease`'s shared capability-permission broker; platform API selection and grant memory live in that shared owner.
- `RecordAudioPanel.tsx` owns user interaction, diagnostics, chunk persistence, playback URL creation, and workflow writes. It does not branch on Safari, WebKit, macOS, iOS, Tauri, or any app shell name.
- Its embedded arrangement passes `placeable-surface-list::recording-workspace` so empty states offer recorder-adjacent surfaces instead of the top-level catalog.

## In Trillion

| File | Purpose |
|------|---------|
| `MeetingAssociationPanel.tsx` | The linked meeting and its Change choice: a searchable shared Dropdown (Search meetings) of nearby calendar events, with Link, Unlink, Open and Refresh. |
| `MeetingNoteMetadata.tsx` | Label and value rows for a note's own facts (Created, Updated); the caller supplies the words and values (`src/workspace/meeting-review.json` metadata). |
| `record-in-the-browser.ts` | The one recorder every Trillion screen uses (message box, Record screen, teleprompter): records a source from `../read-data/capture-sources.json` through MediaRecorder, with live words, plain problem words, the recording-kind fallback and a quiet-microphone notice. See the part's README, section In Trillion. |
| `../read-data/capture-preflight.mjs` | What is checked before a recording starts (room to keep it, battery) and held while it runs (the device stays awake), as rows in `capture-preflight.json`; `startCapture` runs it and stops a recording that cannot succeed with the plain words in `capture-sources.json` problems. `test/capture-preflight.test.mjs`. |
| `edit-recording.ts` | The sound side of editing a voice recording on the Record screen: decode it, play an edit (spans of the recording made, in order) from any second, and make the edited recording as a WAV file. |
