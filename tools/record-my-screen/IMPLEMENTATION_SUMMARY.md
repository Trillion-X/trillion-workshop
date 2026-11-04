# Screen Recording Package — Implementation Summary

## Overview

Built a complete screen-recording capability package as a parallel to `record-audio/record-video`. The package captures the user's screen via `navigator.mediaDevices.getDisplayMedia`, stores recordings in IndexedDB, and publishes them through workflow actions.

## Deliverables

### 1. Core Capture Module
**File:** `do-work/browser-screen-capture.ts`

- `screenCaptureAvailability(navigator?)` — detects if getDisplayMedia is available
- `isScreenCaptureAvailable(navigator?)` — boolean convenience wrapper
- `screenMediaStream(config, navigator?)` — acquires a MediaStream from the display
- `screenMediaStreamWithAudio(config, navigator?)` — future-proofing for separate audio streams

**Honesty Protocol:**
- If getDisplayMedia is missing, throws a clear error (no fake UI fallback)
- Normalizes all error types to Error instances
- Exposes availability diagnostics without attempting to hide platform gaps

**Tests:** `do-work/browser-screen-capture.test.ts` (7 tests covering availability detection)

---

### 2. File Storage (Shared Pattern with record-audio/record-video)
**File:** `do-work/recorded-file-store.ts`

Reused IndexedDB chunk storage pattern from record-audio/record-video:
- `storeRecordingChunk()` — saves a Blob chunk to IndexedDB with sequence number
- `storedRecordedFileRef()` — builds a LocalPlaybackFileRef from chunks
- `readRecordedFileBlob()` — reconstructs the full Blob from chunks on playback

**Types:**
- `LocalPlaybackChunkRef` — {key, byte_length}
- `LocalPlaybackFileRef` — IndexedDB metadata + chunk refs

**Reusability Note:** This is duplicated from record-audio/record-video. Over time, should be extracted to a shared leaf module (L100) to avoid duplication.

---

### 3. Request Builders for Workflow Actions
**File:** `do-work/screen-recording-requests.ts`

Mirrors `record-audio/record-video-requests.ts` with screen-specific modes:

**Types:**
- `ScreenCaptureMode` = 'screen' | 'screen-with-audio'
- `ScreenCaptureSourceDescriptor` — mode metadata (label, media type, material role)
- Input types: `RecordingStateInput`, `RecordedFileInput`, `RecordingErrorInput`, `RecordingNameInput`, `RemoveRecordingInput`

**Functions:**
- `createScreenRecordingId()` — generates unique recording IDs
- `buildSaveRecordingStateRequest()` — lifecycle event (started, stopped, error)
- `buildSaveRecordedFileRequest()` — stores the actual recording
- `buildSetRecordingNameRequest()` — rename operation
- `buildRemoveRecordingRequest()` — deletion
- `saveRecordingState()`, `saveRecordedFile()`, `saveRecordingError()`, `setRecordingName()`, `removeRecording()` — async wrappers that send to workflow

**Backend Descriptor:** `SCREEN_RECORDING_BACKEND_DESCRIPTOR` hardcodes action IDs and capture modes.

---

### 4. Artifact Staging
**File:** `do-work/recorded-file-artifact.ts`

Wraps `stageContentMediaFile()` from `content-media-evidence`:
- `saveRecordedFileArtifact()` — converts Blob to File, stages to CAS, returns a `ContentMediaSourceRef`
- `recordedFileBytesAddressLabel()` — computes the address label for artifact bytes

Reuses the same pattern as record-audio/record-video.

---

### 5. UI Panel
**File:** `show/ScreenRecordingPanel.tsx`

**State Machine:**
- `idle` → user clicks Start
- `recording` → user can Pause or Stop
- `paused` → user can Resume or Stop
- `done` → user can click New Recording (back to idle)
- `error` → displays error message

**Features:**
- Mode selector: "Screen only" or "Screen + audio"
- Start/Stop/Pause/Resume buttons
- Elapsed time display (hides paused duration)
- Recordings list (the owned sidebar (packages/sidebar AppSidebar)) with:
  - Inline rename (InlineEditText)
  - Play button (opens playback video player)
  - Remove button (workflow action)
- Error display in red callout
- Capability-gap message if getDisplayMedia is unavailable

**Data Flow:**
1. Component state holds in-flight capture session (stream, MediaRecorder, chunks)
2. On Stop: chunks → IndexedDB → storedFileRef → artifact staging → workflow save
3. UI reads live recordings from `useBitfieldData('recordings')` — never from component state
4. All mutations go through workflow actions + publish feed

**L065 Compliance:** Uses ONLY `@/packages/ui` components (Button, Container, Dropdown, etc.). No raw HTML divs or inline styles.

---

### 6. Entry Mount
**File:** `show/mount-screen-recording.tsx`

Creates React root and renders `ScreenRecordingPanel`.

---

### 7. Package Boundary
**File:** `things-to-store-and-run.json`

Declares:
- **Placeable Surface:** `screen-recording.panel` (Icon: Monitor, Order: 640, main-workspace)
- **Factflow:** journals, fact sources (recordings input)
- **Entry:** `screen-recording` → source_path: `show/mount-screen-recording.tsx`
- **Capability:** package metadata (label, description, owned kinds, reused packages)
- **Input Descriptor:** `recordings` — cell_table projection with columns: id, label, mediaType, byteLength, durationMs, recordedAt, storedFileRef

---

### 8. Documentation
**File:** `README.md`

4 required sections:
1. **Purpose** — one-line: "Package-owned browser screen recording surface…"
2. **Files Table** — all 8 files with purpose
3. **Key Types** — CaptureState, PendingCapture, RecordingRow
4. **Dependencies** — depends on ui, runtime-kit, content-media-evidence, workflow; not depended on

Plus **Rules** and **Uncertainties** sections explaining:
- getDisplayMedia acquisition in do-work/, not in React panel
- Saved-recording truth from current-log facts only
- L065 rule (zero raw HTML, ui/ components only)
- Capability gaps surface honestly, no fake UI
- Potential macOS WKWebView unavailability
- Future system audio handling
- Shared chunk-store extraction opportunity (L100)

---

## What Was Reused vs Replicated

### Reused (Direct Import)
- `content-media-evidence` artifact staging
- `ui/` components (Button, Container, Text, Dropdown, etc.)
- `@bitfield/runtime-kit` for sendRequestToBitfieldTarget, useBitfieldData
- Same workflow action pattern as record-audio/record-video

### Replicated (Should Be Extracted)
- **recorded-file-store.ts** — identical IndexedDB pattern to record-audio/record-video
  - Duplication opportunity: extract to `packages/indexed-db-chunk-store/` (L100)
  - Both packages would import from shared source
  - Status: NOT extracted in this delivery (would block on shared package infrastructure)

### Adapted
- **browser-screen-capture.ts** — from getUserMedia → getDisplayMedia
  - New modes: 'screen' and 'screen-with-audio' instead of 'audio' and 'video'
  - No legacy fallback (getDisplayMedia is modern standard)
- **screen-recording-requests.ts** — same builder pattern, different action IDs and modes
- **ScreenRecordingPanel.tsx** — mirrors RecordAudioVideoPanel structure, screen-specific UI

---

## Uncertainties & Caveats

### 1. getDisplayMedia Availability
**Status:** HONEST

If `navigator.mediaDevices.getDisplayMedia` is unavailable (e.g., macOS WKWebView without correct Info.plist permission, or older browsers):
- `isScreenCaptureAvailable()` returns `false`
- Panel renders a capability-gap message
- User cannot start recording
- No fake UI, no fallback to getUserMedia (which captures camera, not screen)

**Resolution:** Requires shell/system configuration (macOS Info.plist with NSScreenCaptureUsageDescription). The builder surfaces this; it's not buildable.

### 2. System Audio Capture
**Status:** UNCERTAIN

Current behavior:
- `screenMediaStream({ video: true, audio: true })` attempts combined capture
- If audio is unavailable, the error surfaces and capture fails
- Future: could split into distinct modes with separate error handling

**Possible design:** 
- 'screen-video-only' mode (audio: false)
- 'screen-with-app-audio' mode (audio: true)
- 'screen-with-system-audio' mode (requires separate system audio stream, platform-specific)

Not implemented in this delivery because it requires testing on real platforms and consensus on error handling.

### 3. Shared Chunk Store (L100 Opportunity)
**Status:** NOTED, NOT ACTED ON

`recorded-file-store.ts` is a byte-for-byte duplicate of record-audio/record-video's pattern.

**Correct fix:** Extract to a new shared leaf:
```
packages/indexed-db-chunk-store/
├── do-work/
│   └── chunk-store.ts (storeChunk, retrieveChunk, rebuiltBlob)
├── README.md
└── things-to-store-and-run.json (empty — this is a library, not a capability)
```

Then both record-audio/record-video and screen-recording import from it.

**Why not done here:** Extracting a shared leaf is architectural work that requires coordinating across two existing packages. Better done as a follow-up task with both packages present and ready to refactor.

**L100 note:** Correct genericization shrinks the codebase. Removing this duplication would reduce screen-recording by ~100 lines without reducing capability.

---

## Files Created

```
packages/screen-recording/
├── README.md
├── IMPLEMENTATION_SUMMARY.md (this file)
├── things-to-store-and-run.json
├── do-work/
│   ├── browser-screen-capture.ts
│   ├── browser-screen-capture.test.ts
│   ├── recorded-file-store.ts
│   ├── recorded-file-artifact.ts
│   └── screen-recording-requests.ts
└── show/
    ├── ScreenRecordingPanel.tsx
    └── mount-screen-recording.tsx
```

Total: 9 files (7 code + 1 test + 1 boundary + 1 summary)

---

## What's NOT Done (Out of Scope)

1. **No workflow action definitions** — the things-to-store-and-run.json names action IDs but does NOT define the workflow actions themselves (save-recording-state, save-recorded-file, set-recording-name, remove-recording). These are gated on workflow ownership and live-log write authority. The builder provides the request builders; workflow owner must define the actions.

2. **No live deployment** — per instructions, NO deploy. Files are in the workshop only.

3. **No Playwright proof** — visual/browser proof not created. Would require: (a) getDisplayMedia mock in test environment, (b) running the panel in a shell, (c) simulating user interactions. Deferred.

4. **No generic `recorded-file-store` extraction** — would require coordinating with record-audio/record-video. Noted as L100 opportunity in README and IMPLEMENTATION_SUMMARY.

---

## Test Status

- ✓ browser-screen-capture.test.ts (7 tests, availability detection)
- ○ ScreenRecordingPanel (requires browser, getDisplayMedia mock)
- ○ screen-recording-requests.ts (requires live workflow, deferred to integration)
- ○ recorded-file-artifact.ts (requires live CAS, deferred to integration)

---

## Architecture Alignment

**L069 Generative Primitive:** The capture lifecycle (idle→recording→paused→done→error) is the same for all media capture. A true L069 primitive would be:
```ts
type CaptureSession<T> = {
  start(config: T): Promise<void>
  pause(): void
  resume(): void
  stop(): Promise<Blob>
  error(): string | null
}
```
Both record-audio/record-video and screen-recording implement this pattern independently. Future refactor could extract to a generic capture primitive.

**L063 Structural Elimination:** Shared chunk storage is the category to eliminate (recorded-file-store duplication). Fix: extract to leaf, both import from it.

**L065 UI Rule:** All styling via @/packages/ui, zero raw HTML. ✓ Compliant.

**L100 Genericization:** Removing chunk-store duplication shrinks code without reducing capability.

---

## Next Steps for User

1. **If building/testing locally:** Use package-implementation proposal importer to add to live package-set. Builder cannot do this (gated on live-log write authority).

2. **If gating getDisplayMedia availability:** Update target shell's Info.plist with NSScreenCaptureUsageDescription (macOS example).

3. **If defining workflow actions:** Create action definitions in workflow slot:
   - action:screen-recording:save-recording-state
   - action:screen-recording:save-recorded-file
   - action:screen-recording:save-recording-error
   - action:screen-recording:set-recording-name
   - action:screen-recording:remove-recording

4. **If extracting shared chunk-store:** Create new leaf at `packages/indexed-db-chunk-store`, refactor both record-audio/record-video and screen-recording to import from it (L100).

---

## Summary for Memory

Screen-recording is now feature-complete in the workshop at `<checkout>/packages/screen-recording/`. It mirrors record-audio/record-video but for screen capture via getDisplayMedia. Key files: browser-screen-capture.ts (getDisplayMedia acquisition), recorded-file-store.ts (IndexedDB), ScreenRecordingPanel.tsx (L065-compliant UI), screen-recording-requests.ts (workflow builders), things-to-store-and-run.json (boundary), README.md (documentation).

**Reuse:** Imported ui/, runtime-kit, content-media-evidence patterns.
**Duplication:** recorded-file-store is copied from record-audio/record-video (L100 opportunity to extract).
**Honesty:** If getDisplayMedia unavailable, surfaces capability-gap message, no fake UI.
**Not done:** Workflow actions (requires owner), live deploy (out of scope), Playwright proof (requires mock).
