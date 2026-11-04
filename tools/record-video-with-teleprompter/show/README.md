# Record Video Show

React surface files for recording, teleprompted founder capture, or importing video.

## Rules

- `browser-media-capture.ts` is the package-facing wrapper over `permission-lease`'s shared capability-permission broker; platform API selection and grant memory live in that shared owner.
- `RecordVideoPanel.tsx` owns user interaction, diagnostics, chunk persistence, playback URL creation, workflow writes, and rendering of `recording-session` teleprompter DATA. It does not branch on Safari, WebKit, macOS, iOS, Tauri, or any app shell name.
- Its embedded arrangement passes `placeable-surface-list::recording-workspace` so empty states offer recorder-adjacent surfaces instead of the top-level catalog.
- Teleprompter scripts, countdown, speech-follow alignment, and auto-stop are emergent DATA from `package::record-video::input::recording-session`. The panel must not hardcode founder-only copy outside those records.
