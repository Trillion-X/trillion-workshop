# parts/ui/show/loading-mark

The one loading animation in Trillion: a needle stitching the look's accent thread (the logo's red on the Trillion look) across the space, pulling it through and starting again. Every wait draws it: the screen-state loading rows (large, over the skeleton), and every spinner (`../spinner`, small) in a pressed button, a file opening, a notification at work, a canvas starting, on app.gettrillion.ai and gettrillion.ai.

## Files

| File | Purpose |
|------|---------|
| `LoadingMark.tsx` | The mark: an SVG thread path, its faint stitch guide, and a needle riding the path by CSS offset-path. |
| `loading-mark-html.mjs` | The same decorative mark for server-rendered page actions, using the shared drawing and CSS motion. |
| `stitch.ts` | The mark's drawing as plain data (`STITCH_PATH`, `NEEDLE_BODY`, `NEEDLE_EYE`), shared by `LoadingMark.tsx` and the server-drawn pages' script (`../server-rendered-page/page-work.mjs`), so both draw the same mark. |
| `index.ts` | Public entry (declared in `../../part.json`). |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `LoadingMark` | `({ size?: 'sm' \| 'md' \| 'lg', label?, className?, ...span attributes })` | Draws the mark; with `label` it is a `role="status"` named by it, without it is decoration beside words that say so. |
| `loadingMarkHtml` | `(size?: 'sm' \| 'md' \| 'lg') => string` | Draws an accessible-hidden copy of the mark inside a server-rendered page action. |
| `LoadingMarkSize` | `'sm' \| 'md' \| 'lg'` | 30x12, 48x18, 96x36 px. |
| `STITCH_PATH` | `string` | The one path the thread lies along and the needle follows (64 x 24 box). |
| `NEEDLE_BODY`, `NEEDLE_EYE` | `string`, `{ cx, cy, rx, ry }` | The needle's body and eye, from `stitch.ts`. |

## Invariants

- CSS and SVG only; the motion is `parts/screen-look/show/loading-mark.css`.
- It appears only after about 300 ms of waiting, so a fast answer never flashes.
- Reduced motion shows the finished stitch and the needle still.
- Inside a button the thread takes the button's text colour.
- `test/every-screen-has-its-states.test.mjs` fails on any other spinner or loader in `src/`, `parts/` or trillion-site `src/`.

## Provenance

Motion anatomy from 21st.dev "Logo Trace Loader" (id 16834: a segment travelling one contour, then resolving) and "Skeleton Loader" (id 19999: a highlight crossing the placeholders); drawn from scratch here, no code copied.

## Dependencies

**Depends on:** `react`; look `parts/screen-look/show/loading-mark.css` (roles `--thread-line`, `--accent-primary`, `--glass-bg-primary`).
**Depended on by:** `../server-rendered-page/page-work.mjs` (a pressed action on a server-drawn page, and a page that only waits), `../spinner` (every small spinner, including `../button`, `../action-control`, `../coss/ui/button`, `../coss/guide`, `../file-preview`, `../loading-overlay`, `../persistence-status`, `../capture-control`, `parts/graph-canvas`, `parts/media-playback`), `../screen-state` (loading rows), `../notifications` (work running without a measure), trillion-site `src/components/ui/shared/spinner`.
