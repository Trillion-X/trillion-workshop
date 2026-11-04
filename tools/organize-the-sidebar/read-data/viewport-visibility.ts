// packages/group/read-data/viewport-visibility.ts
//
// Minimal "scroll into view" for the board camera — the pure primitive that keeps a node ON-SCREEN after a
// programmatic selection (keyboard node navigation, jump-to-from-a-list, search-to-node). Given the camera
// (pan + zoom), the viewport size, and a node's WORLD box, it returns the new pan that brings the box fully
// inside the viewport with a margin, moving as LITTLE as possible — and returns the pan unchanged when the
// box is already visible (no jarring re-centre on every hop). Zoom is never touched. Pure + deterministic
// (no DOM, no clock).
//
// Screen projection is the board's canon: screenX = worldX * zoom + panX (same as `screenToWorld`'s inverse).

export interface Camera {
  readonly panX: number;
  readonly panY: number;
  readonly zoom: number;
}

export interface Viewport {
  readonly w: number;
  readonly h: number;
}

/** A world-space box (a node's x/y/w/h). */
export interface WorldBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** Minimal 1-D pan delta to bring [lo, hi] (screen coords) within [margin, size - margin]. 0 when already
 *  inside. When the span is larger than the visible band, aligns the LOW edge to the margin (best effort). */
function revealDelta(lo: number, hi: number, size: number, margin: number): number {
  const near = margin;
  const far = size - margin;
  if (hi - lo > far - near) return near - lo; // too big to fit → pin the near edge
  if (lo < near) return near - lo; // off the near edge → push toward far
  if (hi > far) return far - hi; // off the far edge → push toward near
  return 0; // already fully visible
}

/**
 * The new `{panX, panY}` that reveals `box` inside `view` under `cam`, moving minimally (unchanged when the
 * box is already fully visible with `margin` px of breathing room). Zoom is preserved. Pure + deterministic.
 */
export function panToReveal(cam: Camera, view: Viewport, box: WorldBox, margin = 24): { panX: number; panY: number } {
  const left = box.x * cam.zoom + cam.panX;
  const right = (box.x + box.w) * cam.zoom + cam.panX;
  const top = box.y * cam.zoom + cam.panY;
  const bottom = (box.y + box.h) * cam.zoom + cam.panY;
  return {
    panX: cam.panX + revealDelta(left, right, view.w, margin),
    panY: cam.panY + revealDelta(top, bottom, view.h, margin),
  };
}

/** True iff `box` is fully within `view` (with `margin`) under `cam` — no pan would move it. */
export function isBoxVisible(cam: Camera, view: Viewport, box: WorldBox, margin = 24): boolean {
  const p = panToReveal(cam, view, box, margin);
  return p.panX === cam.panX && p.panY === cam.panY;
}
