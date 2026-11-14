# parts/ui/show/scroll-thread

One continuous line drawn down a page as the reader scrolls, through every element marked as an anchor.

## Files

| File | Purpose |
|------|---------|
| `ScrollThread.tsx` | The line: reads anchors, builds one smooth path, draws it with GSAP ScrollTrigger. Each stretch between lifts is its own drawn path, so the line is drawn one stretch after another as you scroll (a dash pattern starts again in every stretch of one path, which once drew every later stretch at the same moment and left a still line under the workflow section). |
| `thread-geometry.mjs` | The thread's drawing, the one copy: `random(seed)`, `tangle(center, radius, next)` (a ball of loops), `curve(points, lifted)` (a smooth path), `capSegments(segments, floor)` (keeps that path from going below a floor) and `stopAtEnd(items)` (where the line ends). Each is whole in itself so the opening cover can carry it into a page's first bytes as text. |

## Key Types / Functions

| Export | Shape | Role |
|--------|-------|------|
| `ScrollThread` | `{ strokeWidth?, arriveAt?, leaveAt?, seed?, narrowBelow? }` | Place once inside a positioned container. |
| `random` | `(seed: number) => () => number` | Deterministic random source, so a ball looks hand-drawn and never changes. |
| `tangle` | `(center, radius, next) => {x,y}[]` | Loops around a centre: a ball of thread; bigger balls get more loops. |
| `curve` | `(points, lifted: Set<number>) => string[]` | Catmull-Rom curve through the points as path segments; lifts jump without drawing. |
| `capSegments` | `(segments: string[], floor: number) => string[]` | No control point of the curve goes below `floor`, so the curve cannot sag past it. The page passes the end anchor's lowest point when it marks an end. Not in the opening cover. |
| `stopAtEnd` | `(items: { end: boolean }[]) => items` | The anchors in drawing order, cut after the last one marked `end`; unchanged when none is. |

Anchor attributes on the page's elements: `data-thread-anchor` (order number), `data-thread-x` / `data-thread-y` (where on the element, 0..1), `data-thread-tangle` (radius of a ball of loops; larger balls get more loops so they read as dense), `data-thread-loop` (the line goes once around the element, this many px clear of it), `data-thread-wait` (the line arrives early and waits), `data-thread-lift` (the line lifts off here and lands at the next anchor, so something else, such as a diagram's links, carries it between), `data-thread-end` (this anchor is the last point of the line: the line is drawn through the anchors that come before it in order and never past it, however the others are numbered; with several, the last by order; with none, the last anchor by order is the end as before), `data-thread-narrow-x` / `data-thread-narrow-y` / `data-thread-narrow-tangle` (position and ball size used below `narrowBelow`, default 900 px), `data-thread-when` (`narrow` or `wide`: the anchor counts only at that width). The part sets `data-thread-reached` on each anchor and `data-thread-drawn` (drawn length in px) and `data-thread-total` (the whole line's length, reached at the bottom of the page) on its SVG. Reduced motion draws the whole line, still. At the top of the page the line is already drawn to every waiting anchor the first window shows. The line is drawn in two passes (a thinner second pass wanders a little either side of the first) so its thickness varies like a hand-drawn stroke.

## Dependencies

**Depends on:** `gsap` and `gsap/ScrollTrigger`; theme role `--thread-line`.
**Depended on by:** the gettrillion.ai red-thread landing (`trillion-site/src/designs/2026-09-27-red-thread`); `../thread-cover` (the geometry).
