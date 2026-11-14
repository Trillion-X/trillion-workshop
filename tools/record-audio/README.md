# Record Audio

Package-owned browser recording surface, descriptor-fed recording records, and evidence writers.

## Active Backend Plan

The active backend plan is:

`<checkout>/notes/projects/packages-and-package-sets/record-audio/plans/2026-06-20-record-audio-logic-backend-rebase/2026-06-20-record-audio-logic-backend-rebase.md`

That rebase supersedes the old `recorded_file` and June 16 `captured-media-source` active-backend candidates. Logic/backend work now uses generic record/action/projection descriptors over EEAF facts, workflow owner actions, process/session, material evidence, and current-log projections. Labels such as recording, audio, video, local file, or browser recorder are data, not Physics code.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package data: placeable surface, factflow, contracts, workflow actions, descriptor-fed record/action/projection/material/adapter data, and the `recordings` input descriptor |
| `show/RecordAudioPanel.tsx` | The one recording screen: capture, live waveform, and the log-fed recordings list (play, inline rename, remove) |
| `show/record-in-the-browser.ts` | One browser recorder for DATA-backed sources, including the Mac meeting stream adapter |
| `show/browser-media-capture.ts` | Microphone capture API acquisition + permission diagnostics |
| `show/mount-record-audio.tsx` | Entry mount |
| `do-work/record-audio-requests.ts` | Owner-action request builders/senders |
| `do-work/recorded-file-store.ts` | Chunk store + stored-file refs + blob rebuild |
| `do-work/recorded-file-artifact.ts` | Process-readable artifact writes (engine write-batch) |

## Rules

- `show/browser-media-capture.ts` delegates capability probing and capture acquisition to `permission-lease`'s shared capability-permission broker. The React panel never calls a platform permission API directly.
- The `meeting-audio` source exists only when the native Mac bridge is present. `macos/App/SystemAudioCapture.swift` supplies session-scoped ScreenCaptureKit audio; `show/native-system-audio-session.mjs` filters stale native events and turns capture loss into the shared recorder's ordinary ended path, preserving recorded chunks and ending the mixed track.
- Recorded bytes are saved through the package-owned capture adapter, existing material evidence/source refs, engine write-batch writes, and workflow owner actions. This package does not own transcription, media analysis, identity, composition, or distribution records.
- File import remains the fallback for browser surfaces that expose no capture API at all.
- Saved-recording truth is canonical current-log facts shaped by generic record/action/projection descriptors. The panel lists only from the published `recordings` input. Component state never owns a saved recording.
- `prop:recorded_file:*` is historical active-backend evidence and must not be extended as the replacement contract. New backend work uses descriptor-declared fields and projections.
- Capture-API availability is host physics: the presenting shell must carry microphone/camera usage identity (see `bitfield-runtime-kit/references/macos-webview-presenter/Info.plist`). The package only feature-detects and reports honestly.

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (+ `/react`), `@/packages/ui` (sanctioned), `@/packages/local-files` file choice capability, `slot::workflow` + `slot::find-current-items` via owner actions.
**Depended on by:** downstream consumers discover recorded files only through evidence records/addresses (`audio-transcription`, `media-analysis`) — never by import.

## In Trillion

Ported from `<checkout>/packages/record-audio`; every difference from that package is listed in `scripts/port-sources.json`. Trillion records in the browser through one recorder built on this package, used by every screen that records (the message box in `parts/ui/show/composer`, the Record screen and its teleprompter in `src/workspace/record-screen.tsx`):

| File | Purpose |
|------|---------|
| `show/record-in-the-browser.ts` | The one recorder: `startCapture(source, { stream?, audioDeviceId?, onHeard?, onWordsUnavailable?, onProblem?, onEnded? })` records a source through MediaRecorder (the stream opened by this package's `browser-media-capture.ts`, record-video's, or screen-recording's `browser-screen-capture.ts`; paused time kept by `recording-lifecycle.ts`). A chosen microphone flows through the shared permission broker for voice or video, including the camera preview; other callers keep the default. The recorder reports the words the browser hears and a microphone that hears nothing, and `stop()` hands back `{ file, seconds }`. A recording kind the browser refuses falls back to the browser's own kind; a recording that cannot start throws a `RecordingProblem` whose `said` is plain words; a recording the browser stops by itself keeps what it made. |
| `show/native-system-audio-session.mjs` | Routes native start, PCM and failure events only to their matching capture session, removes listeners on close, and ends a mixed track through the recorder's normal source-ended signal when native capture fails. |
| `do-work/recording-on-device.ts` | Every piece of a recording kept on this device the moment it is made (`keepOnDevice(opening, store?)`), in `do-work/recorded-file-store.ts`'s IndexedDB, under a lease renewed while the page records; a page that closed mid-recording leaves it for `unfinishedRecordings(account)` to find (only the signed-in account's, only once its lease ran out) and `reopenOnDevice(found)` to finish. `forget()` deletes it once it is kept in Files. Ported from `show/RecordAudioPanel.tsx`'s chunk persistence and journal recovery. |
| `do-work/send-while-recording.ts` | `sendWhileRecording(recording, client, name)` sends the pieces the device holds into one growing file of unknown length in the person's Files while the recording goes on (readable by name from its first piece), records each span it sends in the device journal before sending it, and finishes the file at Done from the device copy. A connection that drops is tried again (1 to 30 s); a file the service no longer holds is started again from the device copy; a refusal stops and says why. `GrowingClient` is the one seam to the service. |
| `do-work/always-recording.ts` | `startAlwaysRecording({ settings, inputs, client, keepList, account, device, paused })` records any number of inputs (cameras with or without their own sound, microphones) at once and without end, through the one recorder (`startCapture` on a copy of each input's stream), cut on the clock into pieces that each play on their own; every piece is kept on the device (`keepOnDevice`) and sent while it is recorded (`sendWhileRecording`), a list of every piece is kept beside them, an input that stops is opened again every `reopen_after_ms`, and `paused(input)` (asked every second) pauses one. `sendLeftOver(account, client)` finishes pieces a closed page left on the device; `isFeedPiece(keptWith)` tells them from other recorders' device copies. |
| `do-work/rolling-segments.mjs` | The arithmetic of recording that never stops: `windowAt(ms, seconds)` (pieces cut every `seconds` from the device's midnight, so every input on every device cuts at the same instants), `pieceName({ folder, startMs, input, extension })` (day folder, `16.20.00 <input>.<ending>`), `inputName(label, fallback)` (a device label without bus numbers), `sessionList(...)` (every piece grouped by the moment it was recorded). |
| `show/edit-recording.ts` | `decodeRecording(blob)`, `renderEdit(sound, edit, sampleRate?)` (an edit is spans of the recording made, in the order they play, made in an OfflineAudioContext), `wavFile(sound, name)` and `playFrom(sound, seconds, onTime, onEnd)`: the sound side of cutting a part out of a voice recording or recording into it. |
| `read-data/capture-sources.json` | DATA for the one recorder: the sources (voice, camera, screen, and the always-on camera and microphone feeds, `listed: false` so only a screen naming them records from them), which package opens each stream, how each previews, the recording kinds tried in order and their file endings, the file name, the plain words for each problem, and how long a microphone may hear nothing. |
| `read-data/heard-words.mjs` | The words heard while recording with a line said again and again back to back kept once (`loopFreeWords`, read incrementally; `withoutLoops`), and `isMostlyRepeated`, whether a stretch is one line on repeat, so the Record screens show and keep it once and never hand it to the person's AIs. |
| `read-data/heard-words.json` | DATA for heard-words.mjs: longest repeated phrase, copies in a row that make a loop, how alike two copies must be, and the share of different three-word runs under which a stretch is a line on repeat. |
| `part.json` | What other parts and screens may import from this part: the one recorder and its DATA, `show/RecordAudioPanel.tsx` and the package's `things-to-store-and-run.json` (the Record audio screen). |
| `show/live-recording-controls.ts` | `pauseLiveRecording(failed, now?)`, `resumeLiveRecording(failed, now?)`, `stopLiveRecording(reasonRef, sourceRef)` and `captureJournal(live, phase?)`: what can be done to the recording in progress from anywhere, moved out of `show/RecordAudioPanel.tsx` so the screen, the floating card and the pill press the same functions. |
| `show/recording-notices.ts` | `keepRecordingNotices({ openNote, problem })`: the "Recording ongoing" card (Pause or Resume, Stop recording, Open note), then "Preparing meeting note", ending as "Your meeting note is ready", as notifications in the one notification center, in step with the live recording. A cancelled recording leaves none. |
| `show/RecordingPill.tsx` | `mountRecordingPill(host)`: the small pill (time, Pause or Resume, Stop, microphone menu) on the look's island ground, shown while the window is not in front: in the window a Mac host floats over other apps (`recording-widgets.json` `window`, `macos/App/RecordingWindow.swift`), else at the top of the page. A microphone chosen while the recording runs is fed into it at once with no gap (`switchLiveRecordingMicrophone`, `record-in-the-browser.ts` `openSwitchableMicrophone`) and kept for the next recording (`RecordAudioPanel`'s `microphone` prop). |
| `show/ProcessingStepsPill.tsx`, `read-data/processing-steps.ts` | The Upload, Transcript and Summary stages on a recording's note while it is processed; each stage is read from a fact the note holds (file kept, words kept or being made, summary saved). |
| `read-data/recording-widgets.json` | DATA for all of the above: words, buttons and when each shows, the ad-hoc note's title, the microphone preference and the steps. |

A recording also has its note from the moment it starts: `RecordAudioPanel` sends the `begin-recording-note` action (declared in `things-to-store-and-run.json`, kept by `src/workspace/recordings.ts` as a row with state `recording` named by the meeting or `adhoc_title`); the finished recording fills that row in and keeps the name and notes the person wrote meanwhile, and Cancel removes it.


`show/RecordAudioPanel.tsx` is the Record audio screen as it is (`src/workspace/record-audio-screen.tsx`, entry `record-audio`, sidebar "Things you do as input"): its recording library reads the package's own published descriptors and feeds from `things-to-store-and-run.json`, and what it saves is kept in Files and handed to the person's AIs by `src/workspace/recordings.ts`.

| Name | Signature / Shape | Role |
|------|-------------------|------|
| `CAPTURE_SOURCES` / `captureSource(id)` | `CaptureSource[]` / `CaptureSource \| null` | The sources as DATA. |
| `OPENERS` | `Record<ask, { available(), open() }>` | Which package asks the browser for a source's stream, by its `ask`. A new way of asking is one entry. |
| `canCapture` | `(source) => boolean` | Whether this browser can record from it; screens offer only those. |
| `openSource` | `(source) => Promise<MediaStream>` | Opens a stream before recording (a camera's picture); throws a `RecordingProblem`. |
| `startCapture` | `(source, events?) => Promise<Capture>` | `Capture`: `{ source, stream, startedAt, mediaType, fileName, elapsedMs(), paused(), pause(), resume(), soFar(): Promise<Blob>, stop(): Promise<{ file, seconds }>, discard() }`. `events.onPiece(piece)` hears every piece in order (about one a second, and one at each pause); the finished file is exactly those pieces. |
| `keepOnDevice` / `unfinishedRecordings` / `reopenOnDevice` | `(opening, store?) => Promise<DeviceRecording>` / `(account, store?) => Promise<FoundRecording[]>` / `(found, store?) => Promise<DeviceRecording>` | `DeviceRecording`: `{ id, name, mediaType, stored(), storedBytes(), failed(), closed(), add(piece), onChange(fn), pieces(from?, to?), file(), upload(), setUpload(u), keptWith(), setKeptWith(v), seconds(), setSeconds(s), close(), forget(), release() }`. |
| `sendWhileRecording` / `SendProblem` / `GrowingClient` | `(recording, client, name, options?) => Sending` / `Error & { kind: 'again' \| 'restart' \| 'refused' }` / `{ start, piece, finish, cancel, identity }` | `Sending`: `{ state(): { sent, kept, waiting, problem, empty }, onChange(fn), whenKept(): Promise<{ identity, byte_length }>, retry(), stop(), cancel() }`. |
| `decodeRecording` / `renderEdit` / `wavFile` / `playFrom` | see `show/edit-recording.ts` | Cut, insert and play back a voice recording's edit. |
| `RecordingProblem` / `problemKind` / `problemWords` | `Error & { kind, said }` / `(error) => string` / `(error, source) => string` | The browser's name for what went wrong, and the plain words from the DATA. |
| `momentName` / `extensionOf` | `(Date) => string` / `(source, mediaType) => string` | A moment as it goes in a file name; the file ending for what was recorded. |

**Depends on (Trillion):** `parts/record-video/show/browser-media-capture.ts` and `silence-stop.ts`, `parts/screen-recording/do-work/browser-screen-capture.ts`, `parts/permission-lease/read-data/capability-permission.ts`, the browser's MediaRecorder, getUserMedia, getDisplayMedia, AudioContext and speech recognition.
**Depends on (Trillion, keeping):** `do-work/recorded-file-store.ts` (IndexedDB `record-audio`), the browser's IndexedDB, OfflineAudioContext and `navigator.storage.persist`; the service side of `GrowingClient` is `src/workspace/upload.ts` `growingFiles` over `src/namespace.mjs` growing files.
**Depended on by (Trillion):** `parts/ui/show/composer/Composer.tsx` (and `momentName` through `parts/ui/show/composer/index.ts` for `src/workspace/send-message.ts`), `src/workspace/record-screen.tsx`.
