# canvas-shape/

A blind, bbox-filling geometric-shape primitive for canvas items — renders a caller-supplied SVG path (percent-space) scaled to fill the parent box, with centred content on top.

| File | Purpose |
|------|---------|
| `CanvasShape.tsx` | `CanvasShape` component + `CanvasShapeProps`. Renders `path` (a `d` in a `0 0 100 100` viewBox) as a box-filling SVG fill (`preserveAspectRatio="none"` + `vector-effect="non-scaling-stroke"`) with `children` centred over it, and a `shadow` (x, y, blur, spread, colour, opacity) drawn as the same path beneath it, grown by its spread, moved and softened, so a circle's shadow is a circle. With no fill or stroke given it uses the look's `--surface-secondary` and `--border-primary`. |
| `index.ts` | Barrel — re-exports `CanvasShape` + `CanvasShapeProps`. |

## Key Types

| Type | Shape | Role |
|------|-------|------|
| `CanvasShapeProps` | `{ path: string; fill?: string; stroke?: string; strokeWidth?: number; shadow?: TuningShadow \| null; children?: ReactNode }` | The opaque shape path (DATA, from the caller's catalog) + style + centred content. |
| `CanvasShape` | `React.FC<CanvasShapeProps>` | Box-filling shape renderer; blind to WHAT it draws. |

## Why This Design

A canvas "shape" was previously a CSS `clip-path` on content that did not fill the box — so a circle clipped partial-height content and rendered as a half-circle "dome" (#213). `CanvasShape` makes the shape a FILLING path that always spans the box. It is the live twin of the SVG-export path (same geometry → live == export). Blind/generic (L090): the path is opaque DATA — adding a shape is a new catalog row, this renderer is unchanged.

## Dependencies

**Depends on:** `react`; the `TuningShadow` type from `../tuning-panel` (the one shadow shape every inspector row writes).
**Depended on by:** `packages/ui` barrel (`index.ts`); `packages/group` `item-renderers` (board shape items, resolving the path from `board-shapes` `shapeSvgPathById`).
