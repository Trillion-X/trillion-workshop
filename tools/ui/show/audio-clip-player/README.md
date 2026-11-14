# audio-clip-player

One-row inline audio player for a clip inside a list row or a card: play/pause, a thin seek line, the m:ss readout, volume, the speed menu and an optional download. Seek and volume work with the keyboard as well as pointer input; arrow keys move by five seconds or five percent, Page keys move by thirty seconds or ten percent, and Home/End jump to a boundary.

## Files

| File | Purpose |
|------|---------|
| `AudioClipPlayer.tsx` | The player. Raw `<audio>` lives only here; callers pass a source. Its speed menu offers the shared speed scale's steps (`../speed-control/speeds.json`), with the pitch kept by the browser. |

## Key Types / Functions

| Name | Shape | Role |
|------|-------|------|
| `AudioClipPlayer` | `({ src, autoPlay?, onEnded?, downloadName?, rate? }) => JSX` | Plays one clip. `rate` is the speed it starts at (times natural), such as the speed the person set for where it is heard; it follows later changes, and the listener can still pick another step. |
| `AudioClipPlayerProps` | the props above | Exported type. |

## Dependencies

**Depends on:** `parts/ui` Button, Container, Dropdown, Icon, ProgressBar, Text, `speed-control` (the speed scale and its labels), Radix Popover, lucide icons.

**Depended on by:** `attention-stack`, `record-views/hover-form`, `one-at-a-time-queue`, `parts/record-video` (`RecordVideoPanel`).
