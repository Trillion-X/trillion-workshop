# canvas-surface

The generic camera-tracking surface layer (background color + an optional repeating tile) for any 2D canvas — the primitive of which the dot-grid is one configuration.

## Files

| File | Purpose |
|------|---------|
| `CanvasSurface.tsx` | The surface background component: a solid color plus an optional DATA-defined tile (dots / grid / lines / paper) that pans and scales with the camera. Blind to what the tile draws. |
| `index.ts` | Barrel export. |

## Key Types

| Type | Signature / Shape | Role |
|------|-------------------|------|
| `CanvasSurface` | `({ panX, panY, zoom, color?, tile? }) => JSX` | Absolutely-positioned, pointer-transparent surface that pans/scales with the camera. `color` + `tile` both absent → transparent no-op. |
| `CanvasSurfaceProps` | `{ panX; panY; zoom; color?: string; tile?: CanvasSurfaceTile }` | Props. |
| `CanvasSurfaceTile` | `{ image: string; size: number; opacity?: number }` | A repeating tile: opaque CSS `background-image` + WORLD-px edge `size` (scales with zoom) + optional `opacity`. |

## Why this exists

A dot grid is just `tile = radial-gradient`; a grid is two `linear-gradient`s; a paper is a `color` with no tile. Rather than a component per look (LEGO), one primitive renders any look from DATA (clay): adding a surface is a catalog row in the consumer, zero new render code here. `CanvasDotGrid` is now a thin call to this with the dot tile.

## Dependencies

**Depends on:** React only. Colors/images are caller-supplied opaque DATA (or token vars).
**Depended on by:** `canvas-dot-grid` (delegates here), `surface-swatch` (preview), and any canvas package needing a configurable surface (e.g. the group/vision-board board background).
