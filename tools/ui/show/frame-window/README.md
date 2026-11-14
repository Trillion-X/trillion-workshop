# parts/ui/show/frame-window

A still of a video with a draggable window showing what part of the picture stays in a chosen frame shape.

## Files

| File | Purpose |
|------|---------|
| `FrameWindow.tsx` | `FrameWindow`: the still (a muted video element at a time), the window sized to the frame's shape divided by a zoom, dimmed outside, moved by pointer drag or arrow keys (Shift for bigger steps), with an optional CSS colour filter and mirror. `frameWindowBounds`: the window's clamped centre, size and corner in 0..1 of the picture. |
| `index.ts` | Barrel: `FrameWindow`, `frameWindowBounds`, `FrameWindowCenter`, `FrameWindowProps`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `FrameWindow` | `(props: FrameWindowProps) => JSX.Element` | The draggable frame picker. |
| `FrameWindowProps` | `{ source, at, frameAspect, zoom, center, filter?, mirror?, label, onChange(center) }` | `center` is the point of the picture kept centred, 0..1 across and down. |
| `frameWindowBounds` | `(sourceAspect, frameAspect, zoom, center) => { x, y, width, height, left, top }` | The window in 0..1 fractions, clamped inside the picture. |
| `FrameWindowCenter` | `{ x: number; y: number }` | A position. |

## Dependencies

**Depends on:** React; `../selection/crop-position.mjs` (`cropBounds`, the one owner of the frame-in-picture math).
**Depended on by:** `src/workspace/media-edit/look-panel.tsx` (the editor's Colour panel). The render side of the same framing is `parts/media-composition/read-data/looks.mjs` `framingFields`.

## Invariants

- Domain-blind: it knows pictures, shapes and positions, never what the video is.
- A mirrored still flips the window with it, and drags and arrow keys move the way they look.
