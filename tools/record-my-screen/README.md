# Screen Recording

Package-owned browser screen recording surface, descriptor-fed recording records, and evidence writers. Captures the user's screen via `navigator.mediaDevices.getDisplayMedia`, stores chunks in IndexedDB, and publishes recordings through workflow actions.

## Active Backend Plan

This package mirrors the architecture of `record-audio/record-video` but for screen capture instead of microphone/camera input. Logic uses generic record/action/projection descriptors over EEAF facts, workflow owner actions, and material evidence. Labels such as recording, screen-only, screen-with-audio, or browser recorder are data, not Physics code.

## Files

| File | Purpose |
|---|---|
| `things-to-store-and-run.json` | Package data: placeable surface, factflow, capability, inputs |
| `show/ScreenRecordingPanel.tsx` | The recording surface: capture controls, elapsed time, recordings list |
| `show/mount-screen-recording.tsx` | Entry mount point |
| `do-work/browser-screen-capture.ts` | Screen capture API acquisition via getDisplayMedia + availability diagnostics |
| `do-work/recorded-file-store.ts` | IndexedDB chunk storage and file reconstruction (shared pattern with record-audio/record-video) |
| `do-work/recorded-file-artifact.ts` | Artifact staging to material evidence storage |
| `do-work/screen-recording-requests.ts` | Workflow action request builders/senders |

## Rules

- Screen capture acquisition lives in `do-work/browser-screen-capture.ts`. The React panel must not call `navigator.mediaDevices.getDisplayMedia` directly because browser surfaces may vary in their WebAPI exposure.
- Recorded bytes are saved through the package-owned capture adapter, existing material evidence/source refs, and workflow owner actions. This package does not own media analysis, composition, or distribution records.
- Saved-recording truth is canonical current-log facts shaped by generic record/action/projection descriptors. The panel lists only from the published `recordings` input. Component state never owns a saved recording.
- Capture-API availability is host physics: the presenting shell must carry display/screen-capture usage identity. The package only feature-detects and reports honestly. If getDisplayMedia is unavailable, the panel renders a capability-gap message, not a fake UI.

## Dependencies

**Depends on:** `@bitfield/runtime-kit` (+ `/react`), `@/packages/ui` (sanctioned), `@/packages/content-media-evidence` (artifact staging), `slot::workflow` via owner actions.

**Depended on by:** downstream consumers discover recorded files only through evidence records/addresses (media-analysis, media-composition) — never by import.

## Uncertainties

- **WASM webview availability:** The specification notes that `navigator.mediaDevices.getDisplayMedia` may not be available in all browser surfaces (e.g., macOS WKWebView without explicit permission in Info.plist). The package surfaces this honestly via `isScreenCaptureAvailable()` and a capability-gap message.
- **System audio capture:** Some platforms require separate handling for system audio vs application audio. The current implementation attempts combined capture; if audio is unavailable, the error surfaces. Future work may separate screen-only from screen-with-system-audio as distinct modes with different error handling.
- **Shared chunk store:** The IndexedDB chunk storage (`recorded-file-store.ts`) is identical to record-audio/record-video's pattern. Over time, this should be extracted to a shared leaf module (L100) so both packages import from the same source rather than duplicating the logic.
