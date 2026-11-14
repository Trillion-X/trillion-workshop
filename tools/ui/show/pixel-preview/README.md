# pixel-preview

A picture or video drawn through the caller's own pixel function, frame by frame, so a change shows the moment a control moves (a colour grade previewed live while the full render runs only when it is kept).

## Files

| File | Purpose |
|------|---------|
| `PixelPreview.tsx` | The preview: the media plays muted and looping in the shared `MediaFrame` (out of sight) and every frame is drawn onto a canvas, scaled to `maxWidth`, through `paint`. Paused, a new `paint` redraws the same frame at once. |
| `index.ts` | Barrel export. |

## Key Types / Functions

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `PixelPreview` | `({ source, mediaType, label, paint, maxWidth?, playing?, at?, className? }) => JSX` (forwards the canvas ref) | Draws the media through `paint`; `paint: null` draws the original. |
| `PixelPaint` | `(data: Uint8ClampedArray) => unknown` | Changes one frame's RGBA bytes in place. |
| `PixelPreviewProps` | the props above | |

## Invariants

1. Blind: the part never knows what `paint` does.
2. The source is same-origin, so a frame can be read back and compared with a saved result.
3. The canvas carries `data-preview-time` (the frame's moment) and `data-preview-paint-ms` (how long the last paint took).

## Dependencies

**Depends on:** `ui` MediaFrame, cn.
**Depended on by:** `src/workspace/controls-previews.tsx` (the `video-look` preview of an interface of controls).
