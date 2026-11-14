# canvas-dot-grid

Generic camera-tracking dot-grid background layer for any 2D canvas surface.

## Files

| File | Purpose |
|------|---------|
| `CanvasDotGrid.tsx` | The dot-grid background component (camera-aware, token-colored). A thin call to `CanvasSurface` with the radial-gradient dot tile — the dots are ONE configuration of the generic surface primitive. |
| `index.ts` | Barrel export. |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CanvasDotGrid` | `({ panX, panY, zoom, spacing?, dotSize? }) => JSX` | Absolutely-positioned, pointer-transparent dot field that pans/scales with the camera. |
| `CanvasDotGridProps` | `{ panX: number; panY: number; zoom: number; spacing?: number; dotSize?: number }` | Props. |

## Dependencies

**Depends on:** React only. Color via `var(--border-primary)` token.
**Depended on by:** `workflow-canvas` (canvas room background); any graph/canvas package needing a world grid.
