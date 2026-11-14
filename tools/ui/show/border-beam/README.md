# parts/ui/show/border-beam

A light travelling round the border of the box it sits in while that box is at work. The look's thread (the logo's red on the Trillion look) runs the box's edge with a soft bloom, as the loading mark's needle runs its stitch, so a box that is answering shows it in its own outline. It is not a second loading animation: the box's words still say what is happening, and every wait that has no box of its own still draws `../loading-mark`.

## Files

| File | Purpose |
|------|---------|
| `BorderBeam.tsx` | The beam: a decorative layer of shared `Container` spans (a blurred bloom ring and a crisp ring), marked on or off. |
| `index.ts` | Public entry (declared in `../../part.json`). |
| `README.md` | This file. |

## Key Types / Functions

| Export | Signature / Shape | Role |
|--------|-------------------|------|
| `BorderBeam` | `({ on: boolean, className? }) => ReactElement` | Put it as a direct child of the box whose border it travels; `on` while the box is at work. Off fades it out. |
| `BorderBeamProps` | `{ on, className? }` | Its props. |

## Invariants

- Decoration only: `aria-hidden`, no pointer events, no layout of its own; the caller's words say what is happening.
- CSS only, no script per frame: the motion, colour, width and turn time are `parts/screen-look/show/border-beam.css` (`--border-beam-colour`, `--border-beam-width`, `--border-beam-turn`), so a look changes them without code.
- It never flashes: it shows once the work has lasted about 300 ms, and fades out when it ends.
- The box keeps its own corners; the beam inherits them. The box that holds it is positioned by its caller (the shared `Container` `position="relative"`); the shared Container is `static` by default, so without it the beam would fill the nearest positioned ancestor instead.
- Reduced motion holds a still, faint ring.

## Dependencies

**Depends on:** `../container`; the look's `--thread-line` (falling back to `--accent-primary`).
**Depended on by:** `../composer` (the message box's field while a message is being handled).

## Provenance

Motion anatomy from Libraries.dev "Border beam" (`border-beam` on npm, MIT, Jakub Antalik; libraries.dev/beam): a conic light on an animated angle, masked to the border ring, with a blurred bloom. Written from scratch here; no code copied.
