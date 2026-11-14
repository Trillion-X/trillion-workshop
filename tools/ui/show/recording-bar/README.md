# recording-bar/

**Depended on by:** `../composer/Composer.tsx`, `src/workspace/record-screen.tsx`.
**Depends on:** `../button`, `../capture-control` (`ElapsedTime`, `formatElapsed`), `../container`, `../icon/NamedIcon`, `../live-waveform`, `../text`.
## Dependencies
| Name | Shape | Role |
|------|-------|------|
| `RecordingBar` | `({ stream, active, readElapsedMs?, elapsedMs?, picture?, actions, waveformLabel?, 'aria-label'? }) => JSX` | The bar; `data-recording-bar` on its root. |
| `RecordingBarAction` | `{ id, label, icon, main?, onPress, disabled? }` | One action: `main` draws its word on the primary button; the rest are icon buttons named by `label`. |
| `RecordingBarProps` | props above | `active` false holds the wave still (paused). |
## Key Types / Functions
| File | Purpose |
|------|---------|
| `RecordingBar.tsx` | The bar: time, waveform or picture, actions from DATA. |
| `index.ts` | Exports `RecordingBar` and its types. |
## Files
The one row a recording in progress draws on every screen that records: the time with a red dot, the live waveform
(or the camera's picture) taking the room left, and the recording's actions at the end, small. Quiet actions are icon
buttons named by their tooltip; the main one (Done, Stop) carries its word. It fits a 390px pane.
