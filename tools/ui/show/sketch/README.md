# parts/ui/show/sketch

Hand-drawn page parts: pencil outlines, brush-painted buttons, handwritten notes and tags, and illustrations that look drawn on paper.

## Files

| File | Purpose |
|------|---------|
| `Sketch.tsx` | `SketchFrame`, `DoodleButton`, `HandNote`, `ScribbleTag`, `SketchLink`, `SketchFigure`. |
| `sketch-path.ts` | Seeded hand-drawn paths: `sketchRectangle` (pencil outline), `sketchBrush` and `sketchBrushStreaks` (brush-stroke fill), `sketchLoop` (overshooting pen loop). |

## Key Types / Functions

| Export | Shape | Role |
|--------|-------|------|
| `SketchFrame` | `{ seed?, highlighted?, children, ...div attributes }` | Box with a thin pencil outline drawn twice; thread-coloured when highlighted or reached by a ScrollThread. |
| `DoodleButton` | `{ href, children, tone?: 'filled' \| 'outline', seed? }` | A link painted as a red brush stroke (ragged edges, dry streaks) inside a loose overshooting pen loop; `outline` draws only the loops. |
| `HandNote` | `{ children, tilt?, ticks?: 'left' \| 'right' \| 'none' }` | Handwritten note in `--font-hand`. |
| `ScribbleTag` | `{ children, tilt?, className? }` | A red handwritten tag with a pen swash leading in and tick marks after (a plan's "recommended" tag). |
| `SketchLink` | `{ href, children }` | Text link with a drawn underline on hover. |
| `SketchFigure` | `{ src, alt, width, height, priority?, breathe? }` | Illustration that breathes slowly. |
| `sketchRectangle` / `sketchBrush` / `sketchBrushStreaks` / `sketchLoop` | `(seed, ...) => string` | SVG path data in a 0..100 box. |

## Dependencies

**Depends on:** `lucide-react` (check and cross marks); theme roles `--ink-line`, `--pencil-line`, `--thread-line`, `--paper`, `--on-accent`, `--text-primary`, `--text-secondary`; font tokens `--font-headline`, `--font-hand`, `--font-body`; line token `--pencil-stroke`.
**Depended on by:** `show/thread-flow`, the gettrillion.ai red-thread landing (`trillion-site/src/designs/2026-09-27-red-thread`).
