# ui/show/canvas-node — absolute-positioned canvas node primitive

The Physics-layer wrapper that positions one node in world space (`translate · rotate · scale`) and exposes generic pointer/resize hooks — zero domain vocabulary, used by any 2D canvas (board, workflow graph, ER diagram).

## Files

| File | Purpose |
|------|---------|
| `CanvasNode.tsx` | `CanvasNode` component + `CanvasNodeProps`. Renders an absolutely-positioned `div` whose `transform` is `translate(x,y)` plus optional `rotate(θ)` and `scale(±1)` (flip), an optional content `opacity`, an optional content `clipPath` (clips the content into a geometric shape — the selection ring/handles stay crisp on the outer node), selection ring, corner adornment, one-time entrance animation, `data-node-ref` stamping, and 8 invisible edge/corner resize strips. All visual chrome lives in children. |
| `resize-geometry.ts` | `applyResizeGeom(edge, rect, dx, dy, minW, minH)` — the axis-aligned resize SSOT (opposite handle pinned, min-size clamped); `ResizeEdge`/`Rect` types; `RESIZE_EDGES` + `RESIZE_CURSOR` maps. Reused by rotated-resize, group-resize, and image-crop (in normalized space). |
| `index.ts` | Barrel: re-exports `CanvasNode`, `CanvasNodeProps`, `applyResizeGeom`, `RESIZE_EDGES`, `RESIZE_CURSOR`, `ResizeEdge`, `Rect`. |

## Key Types / Functions

| Type / Function | Signature / Shape | Role |
|-----------------|-------------------|------|
| `CanvasNode` | `forwardRef<HTMLDivElement, CanvasNodeProps>` | Absolute world-space node wrapper; `transform: translate(x,y) [rotate(θ)] [scale(sx,sy)]`. |
| `CanvasNodeProps` | `{ x, y, width, height, rotation?, flipX?, flipY?, opacity?, clipPath?, isDragging?, cursor?, selected?, nodeRef?, cornerAdornment?, cornerActions?, appearDelayMs?, onPointerDown/Move/Up?, onClick?, onDoubleClick?, onContextMenu?, onResizeStart? }` | `rotation` (deg, about centre), `flipX`/`flipY` (mirror in local frame, applied after rotate), `opacity` (0..1 — fades the CONTENT only, not the selection ring/handles; absent or ≥1 → opaque), `clipPath` (CSS clip-path applied to the CONTENT only — clips a rectangular item into a geometric shape; absent/'' → no clip = rectangle) — transform/appearance fields absent → pure translate, every existing consumer unchanged. `cornerAdornment` = a NON-interactive overlay just above the top-right corner, never over the content (status badge, e.g. a lock chip or a record's state; `aria-hidden`, `pointer-events:none`). `cornerActions` = an INTERACTIVE bottom-left overlay (a real control, e.g. an open-link chip; receives pointer events, not aria-hidden — the caller's control should stop propagation if it must not also start a node drag). `onResizeStart` present → 8 invisible resize strips. |
| `ResizeEdge` | `'n'\|'s'\|'e'\|'w'\|'ne'\|'nw'\|'se'\|'sw'` | The 8 resize handles (Physics-closed). |
| `Rect` | `{ x, y, w, h }` | Axis-aligned box for resize math. |
| `applyResizeGeom(edge, rect, dx, dy, minW, minH)` | `(ResizeEdge, Rect, number, number, number, number) → Rect` | New top-left+size after dragging `edge` by (dx,dy); opposite handle stays pinned; clamped to min size. The single resize math, reused by `rotated-transform`, group-resize, and `crop-rect`. |
| `RESIZE_EDGES` / `RESIZE_CURSOR` | `readonly ResizeEdge[]` / `Record<ResizeEdge,string>` | Strip iteration order + per-edge CSS cursor. |

## Dependencies

**Depends on:** `@/packages/ui/show/node-actions/node-ref` (`NODE_REF_ATTR`, `serializeNodeRef`, `NodeRef`); React.
**Depended on by:** `group/show/GroupBoardPanel` (board items), `group/show/rotated-transform` + `group/show/crop-rect` (reuse `applyResizeGeom`), and any canvas surface that positions nodes (workflow graph, ER diagram).

## Why This Design

The node wrapper owns ONLY coordinates and pointer events — never what a node "is". Position, rotation, and flip are pure geometry (`transform`), so a new visual capability is a new transform clause (absent → no-op), never a per-kind branch. The resize math is one pure function reused by every resize-shaped feature (item resize, rotated resize, group resize, image crop) rather than re-derived per call site.
