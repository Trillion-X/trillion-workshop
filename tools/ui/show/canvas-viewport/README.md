# ui/show/canvas-viewport/

The fixed window you look THROUGH at an infinite 2D canvas — a position:relative, overflow:hidden, touch-action:none rectangle that clips the world, captures pointer/wheel/double-click/drop events, draws an optional marquee, and exposes its ref so the owner can do screen↔world math.

## Files

| File | Purpose |
|------|---------|
| `CanvasViewport.tsx` | The `CanvasViewport` component (forwardRef div). Owns ZERO domain vocabulary — only a rectangle + event callbacks. Renders children (the world), an optional `selectionRect` rubber-band, and an optional pointer-transparent `overlay` (empty/loading/error). |
| `marquee.ts` | Pure helpers to compute a marquee rectangle (viewport-local px) from two pointer positions, and to hit-test world rects against it. |
| `marquee.test.ts` | Vitest for `marquee.ts`. |
| `index.ts` | Barrel re-export. |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `CanvasViewport` | `forwardRef<HTMLDivElement, CanvasViewportProps>` | The clipping window. Binds `onPointerDown/Move/Up`, `onWheel`, `onDoubleClick`, `onDrop`, `onDragOver` to its root div. `acceptsExternalFiles` marks it as the owner of OS file drops inside an arrangement pane. Does NOT spread `...rest` onto the root — every prop is explicit. |
| `CanvasViewportProps` | `{ height?, fill?, minHeight?, cursor?, children, overlay?, selectionRect?, onPointerDown?, onPointerMove?, onPointerUp?, onWheel?, onDoubleClick?, onDrop?, onDragOver?, 'aria-label'? }` | `onDoubleClick` lets the owner decide what an empty-canvas double-click means (e.g. the board's double-click-empty → new note). `fill` makes it a `flex:1` child; else fixed `height`. |

## Dependencies

**Depends on:** `react` only (zero other package imports — a pure leaf UI primitive).
**Depended on by:** `group/show/GroupBoardPanel` (the board), and any other 2D canvas surface (graph canvas, workflow canvas) that needs the same pan/zoom window. Compose with `CanvasDotGrid` + `CanvasWorldTransform` + `CanvasNode`.

## Why This Design?

Feature code must never hand-roll a raw `<div>` window (L065/L106). One blind viewport serves every canvas. The owner that mounts it interprets events in its own domain — the viewport stays domain-agnostic, so `onDoubleClick` is a generic callback, not a "create note" method.
