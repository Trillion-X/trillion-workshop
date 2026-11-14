# ui/show/crop-overlay — image crop affordance

A world-space overlay that dims around a normalized crop WINDOW and exposes 8 resize handles + a Done button, for cropping one item on a canvas — pure presentation, all crop math lives in the consumer.

## Files

| File | Purpose |
|------|---------|
| `CropOverlay.tsx` | `CropOverlay` component + types. Renders over an item's world rect: a crop window (a 0..1 sub-rectangle of the item) with a huge spread box-shadow that dims everything outside it, 8 edge/corner handles (counter-scaled by 1/zoom), and a Done button. Fires `onHandleDown(e, handle)` per handle and `onDone()`. |
| `index.ts` | Barrel: re-exports `CropOverlay`, `CropOverlayProps`, `CropOverlayRect`, `CropOverlayWindow`, `CropHandle`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `CropOverlay` | `(props: CropOverlayProps) => JSX.Element` | The crop affordance; world-space, tracks pan/zoom. |
| `CropOverlayProps` | `{ item: CropOverlayRect; crop: CropOverlayWindow; zoom: number; onHandleDown: (e, handle: CropHandle) => void; onDone: () => void }` | `item` = world rect; `crop` = normalized window; handle drags resize the window; Done commits & exits. |
| `CropOverlayRect` | `{ x, y, w, h }` | The item's world rect. |
| `CropOverlayWindow` | `{ x, y, w, h }` | The crop window in 0..1 fractions of `item`. |
| `CropHandle` | `'nw'\|'n'\|'ne'\|'e'\|'se'\|'s'\|'sw'\|'w'` | The 8 handles (corners + edge midpoints). |

## Dependencies

**Depends on:** React only (zero domain vocabulary).
**Depended on by:** `group/show/GroupBoardPanel` (image crop mode). The crop geometry (`resizeCrop`/`clampCrop`) lives in the consumer's `group/show/crop-rect`; this component only reports handle presses.

## Why This Design

Mirrors `SelectionBoundsOverlay`: a generic, presentation-only canvas affordance with one pointer-down callback per handle. The crop window is data (a normalized rect the caller owns); the overlay never computes a new crop — it renders the current one and reports drags, so any canvas with croppable content can reuse it without inheriting the board's crop math.
