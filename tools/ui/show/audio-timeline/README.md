# ui/show/audio-timeline

A recording's sound as a timeline moved through with a finger: the place being listened to stays under a fixed line in the middle while the sound slides beneath it, two fingers or a trackpad pinch zoom around that line, and a chosen part sits between two handles.

## Files

| File | Purpose |
|------|---------|
| `AudioTimeline.tsx` | The timeline (`AudioTimeline`), how it says a time (`timelineTime`) and the loudness peaks it draws (`peaksOf`). It draws only; what a time or a chosen part means is the caller's. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `AudioTimeline` | `({ peaks, peaksPerSecond, duration, position, onPositionChange, selection?, onSelectionChange?, label, startLabel?, endLabel?, className? })` | Drag scrubs, two-finger pinch, ctrl+wheel and Safari's gesture events zoom, the wheel pans; arrows move, Home/End jump, + and - zoom; each selection handle is a `slider`. |
| `TimelineSpan` | `{ start: number; end: number }` | A chosen part, in seconds. |
| `timelineTime` | `(seconds, tenths?) => string` | `0:07`, or `1:04.5` when zoomed in far enough for tenths to matter. |
| `peaksOf` | `(channels: Float32Array[], sampleRate, perSecond) => Float32Array` | The loudest sample of each slice, 0..1, `perSecond` slices a second. |

## Rules

- Every time handed out is clamped to 0..duration, and a selection's start is never after its end.
- A handle drag keeps the other edge as its anchor, so dragging one past the other swaps them; when both handles are drawn on one spot (a part only a few pixels wide at this zoom), the first move decides which edge moves: left the start, right the end.
- Pixels are derived from position, zoom and width on every drawing; nothing keeps a second copy of where the sound is.
- Colours are read from the mounted screen look's CSS variables at draw time (accent for what was played, muted text for the rest); the canvas is used only for pixels.
- It names no product, file or recording.

## References

Anatomy from Mobbin: Brink's bookmark timeline (https://mobbin.com/screens/8dce49b3-ca4b-40d2-b2ae-44bba3fee9ce) and Polarsteps' trim handles (https://mobbin.com/screens/b6fb5c67-1b0c-491b-974e-f3520ae4bee9). 21st.dev's WaveformPlayer (component 7978) was checked and only seeks, so the zoom and selection are original code.

## Dependencies

**Depends on:** `../cn`, `../playhead`, `../text`, React.
**Depended on by:** `src/workspace/record-screen.tsx` (loaded when a paused voice recording opens its timeline).
