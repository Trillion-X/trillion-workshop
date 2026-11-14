# Record Video

Package-owned browser recording surface, descriptor-fed recording records, and evidence writers.

## Active Backend Plan

The active backend plan is:

`<checkout>/notes/projects/packages-and-package-sets/record-video/plans/2026-06-20-record-video-logic-backend-rebase/2026-06-20-record-video-logic-backend-rebase.md`

That rebase supersedes the old `recorded_file` and June 16 `captured-media-source` active-backend candidates. Logic/backend work now uses generic record/action/projection descriptors over EEAF facts, workflow owner actions, process/session, material evidence, and current-log projections. Labels such as recording, audio, video, local file, or browser recorder are data, not Physics code.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package data: placeable surface, factflow, contracts, workflow actions, descriptor-fed record/action/projection/material/adapter data, and the `recordings` input descriptor |
| `show/RecordVideoPanel.tsx` | The one recording screen: manual video capture plus the zero-friction founder teleprompter session, then the log-fed recordings list (play, inline rename, remove); `onRecordingSaved` is called once a recording is kept, `liveCaptureActions` shows beside the controls while recording, and the subtitle is drawn only when it says something the title does not |
| `show/browser-media-capture.ts` | Capture API acquisition + availability diagnostics |
| `show/mount-record-video.tsx` | Entry mount |
| `do-work/record-video-requests.ts` | Owner-action request builders/senders |
| `do-work/recorded-file-store.ts` | Chunk store + stored-file refs + blob rebuild |
| `do-work/recorded-file-artifact.ts` | Process-readable artifact writes (engine write-batch) |
| `read-data/recording-session.ts` | DATA decoder for teleprompter script text, auto-start/stop, countdown, and speech-follow alignment; every way a take ends is DATA (invariant 5): the final word within `completion_slack_words`, then `script_end_quiet_seconds` without a new word (else `completion_grace_ms`), a stop phrase (`stop_phrases`, `heardStopPhrase`) heard among the newest words that the script itself does not say, silence, or `auto_stop_seconds`; `mirror_script` draws the script mirrored |
| `RECORD-VIDEO-CONSUMER-MIGRATION-MAP.md` | Current downstream consumer map for the split record-video output and the remaining #171 admit/live step |

## Rules

- `show/browser-media-capture.ts` delegates capability probing and capture acquisition to `permission-lease`'s shared capability-permission broker. The React panel never calls a platform permission API directly.
- Recorded bytes are saved through the package-owned capture adapter, existing material evidence/source refs, engine write-batch writes, and workflow owner actions. This package does not own transcription, media analysis, identity, composition, or distribution records.
- The founder teleprompter recorder is emergent DATA. `recording-session` carries the script, countdown, speech-follow, and auto-stop configuration; the panel simply renders and executes that session.
- File import remains the fallback for browser surfaces that expose no capture API at all.
- Saved-recording truth is canonical current-log facts shaped by generic record/action/projection descriptors. The panel lists only from the published `recordings` input. Component state never owns a saved recording.
- `prop:recorded_file:*` is historical active-backend evidence and must not be extended as the replacement contract. New backend work uses descriptor-declared fields and projections.
- Capture-API availability is host physics: the presenting shell must carry microphone/camera usage identity (see `bitfield-runtime-kit/references/macos-webview-presenter/Info.plist`). The package only feature-detects and reports honestly.

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (+ `/react`), `@/packages/ui` (sanctioned), `@/packages/local-files` file choice capability, `slot::workflow` + `slot::find-current-items` via owner actions.
**Depended on by:** downstream consumers discover recorded files only through evidence records/addresses (`audio-transcription`, `media-analysis`) — never by import.

## In Trillion

Ported from `<checkout>/packages/record-video`; every difference is listed in `scripts/port-sources.json`. `RecordVideoPanel` is Trillion's Record video screen (`src/workspace/record-video-screen.tsx`). Its owner actions and the file it stages are answered by `src/workspace/recordings.ts`: the take is kept in the person's Files by day with the words heard beside it, and handed to their AIs. Trillion adds to the panel the words heard over the picture, the waveform under it, a Video or Voice choice and the screen's own actions beside the title; a Formats script reaches the panel as a recording session through `do-work/recording-session-from-presentation-plan.mjs` (the conversion the command-line script now calls).
