# scene-resize-handles/

Blind selected-node resize chrome: eight bounding-box handles + a live `W × H` badge that emit a candidate rect, leaving the engine commit to the consumer.

## Files

| File | Purpose |
|------|---------|
| `SceneResizeHandles.tsx` | The primitive component + `applySceneResize` pure drag-math helper. |
| `README.md` | This file. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `SceneResizeRect` | `{ x: number; y: number; w: number; h: number }` | Stage-pixel rect (zoom = 1). |
| `SceneResizeHandleId` | `'nw'\|'n'\|'ne'\|'e'\|'se'\|'s'\|'sw'\|'w'` | The eight handle anchors. |
| `SceneResizeHandlesProps` | `{ rect, minW?, minH?, revealed?, onResizeStart?, onResize, onResizeEnd? }` | `onResize(rect)` fires live every pointer move; the consumer turns it into a transaction. |
| `SceneResizeHandles` | `(props) => JSX` | Renders the eight handles + active-drag dimension badge. |
| `applySceneResize` | `(id, start, dx, dy, minW, minH) => SceneResizeRect` | Pure: maps a handle drag delta to a new rect, anchoring the opposite edge and clamping to the min floor. Exported for unit tests. |

## Dependencies

**Depends on:** `@/packages/ui/show/cn` (class merge), React.

**Depended on by:** `documents` (mounts it as the chrome plane on `fit="fill"` Component frames). Any scene-graph surface that renders engine rects and wants resize affordances can reuse it — it is package-agnostic.

## Why This Design?

The handles are pointer-transparent except on the dots themselves, so a mounted live surface stays fully interactive between the handles (resize AND interact, not either/or). The component never commits anything — it emits a rect, so the consumer decides whether that becomes `UPDATE_PROPS` on `style.width/height`, a `layout_patch` origin move, or both. That keeps the primitive blind and reusable across any layout model.

## Invariants

1. Generic / blind — no node-type or Society vocabulary; rect in, rect out.
2. Must sit on a non-clipped chrome plane (the frame drops `overflow-hidden` for mounted surfaces — convergence F3/F4), so edge handles render half-outside the box.
3. Container is `pointer-events-none`; only handle dots opt back in.
4. Coordinates are stage pixels at zoom = 1 — client-pixel drag deltas map 1:1.
