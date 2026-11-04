// packages/group/show/camera-frame.ts
//
// The camera-framing primitive — the pure inverse of the board's render transform
// (`screen = world·zoom + pan`). Given a set of world rectangles and the viewport
// size, `frameCamera` computes the `{panX, panY, zoom}` that fits those rects into
// the viewport with padding. It is the generative primitive (L069): Zoom-to-fit is
// caller #1 (all items), Zoom-to-selection is caller #2 (the selected items) — same
// function, different rect set.
//
// `zoomAroundPoint` is the SECOND generative primitive here: change zoom while keeping
// the world point currently under a GIVEN screen anchor fixed. Every canvas-zoom gesture
// is a configuration of it by which anchor it pins: scroll-wheel / pinch zoom pins the
// CURSOR (`{x: clientX, y: clientY}`); double-click-to-zoom pins the CLICK point; the
// reset-to-100% / +/- buttons pin the viewport CENTRE — which is exactly why
// `zoomAroundCenter` is just `zoomAroundPoint` at `{w/2, h/2}` (it delegates, so the
// inverse-transform anchor math lives in ONE place and the two callers can never drift).
//
// Zero I/O, zero React, zero board/Society vocabulary — universal viewport geometry.

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Camera {
  panX: number;
  panY: number;
  zoom: number;
}

export interface Viewport {
  w: number;
  h: number;
}

export interface FrameOpts {
  /** Gap (screen px) kept between the content bounds and the viewport edges. */
  padding: number;
  minZoom: number;
  maxZoom: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The camera that frames `rects` (world coords) inside `viewport`, centred, with
 * `padding` screen-px of breathing room and the zoom clamped to [minZoom, maxZoom].
 * Returns null when there is nothing to frame (caller leaves the camera as-is).
 */
export function frameCamera(rects: readonly FrameRect[], viewport: Viewport, opts: FrameOpts): Camera | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const r of rects) {
    // Skip a malformed (non-finite) rect. A SINGLE NaN/Infinity coordinate would otherwise poison the
    // bounds (`Math.min(x, NaN) === NaN`) → `bw` NaN → the whole camera NaN, killing zoom-to-fit for the
    // ENTIRE board because one item is bad. Fail closed: ignore the bad rect and frame the rest. Use BOTH
    // corners (x and x+w) so a negative w/h still frames the rect's true extent instead of collapsing it.
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) continue;
    const x2 = r.x + r.w;
    const y2 = r.y + r.h;
    minX = Math.min(minX, r.x, x2);
    minY = Math.min(minY, r.y, y2);
    maxX = Math.max(maxX, r.x, x2);
    maxY = Math.max(maxY, r.y, y2);
    any = true;
  }
  if (!any) return null; // every rect was malformed → nothing valid to frame (caller keeps the camera)
  const bw = Math.max(maxX - minX, 1);
  const bh = Math.max(maxY - minY, 1);
  const availW = Math.max(viewport.w - opts.padding * 2, 1);
  const availH = Math.max(viewport.h - opts.padding * 2, 1);
  const zoom = clamp(Math.min(availW / bw, availH / bh), opts.minZoom, opts.maxZoom);
  const cx = minX + bw / 2;
  const cy = minY + bh / 2;
  return { zoom, panX: viewport.w / 2 - cx * zoom, panY: viewport.h / 2 - cy * zoom };
}

/** A screen-space point (viewport-relative px), e.g. the cursor position on the stage. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * Change the camera's zoom to `targetZoom` (clamped) while keeping the world point
 * currently under `anchor` (a screen-space px point) FIXED under that same anchor.
 * This is the anchor-invariant zoom every canvas gesture wants: scroll-wheel/pinch pass
 * the cursor, double-click-to-zoom passes the click point, the +/- buttons pass the
 * viewport centre. The invariant: `toScreen(after, worldUnderAnchor) === anchor`.
 *
 * Fail-safe: a non-finite anchor or a degenerate current zoom (0 / NaN) can't produce a
 * meaningful world point, so we pin the geometric no-op — set the clamped zoom but leave
 * pan unchanged — rather than emit a NaN camera that would blank the board.
 */
export function zoomAroundPoint(cam: Camera, anchor: ScreenPoint, targetZoom: number, minZoom = 0.01, maxZoom = 100): Camera {
  const z = clamp(targetZoom, minZoom, maxZoom);
  if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y) || !Number.isFinite(cam.zoom) || cam.zoom === 0) {
    return { zoom: z, panX: cam.panX, panY: cam.panY };
  }
  const wx = (anchor.x - cam.panX) / cam.zoom; // world point currently under the anchor
  const wy = (anchor.y - cam.panY) / cam.zoom;
  return { zoom: z, panX: anchor.x - wx * z, panY: anchor.y - wy * z };
}

/**
 * Change the camera's zoom to `targetZoom` (clamped) while keeping the world point
 * currently under the viewport centre fixed — the reset-to-100% / centre-zoom op.
 * The centre is just one anchor, so this is `zoomAroundPoint` at `{w/2, h/2}` (single
 * inverse-transform SSOT — the wheel-zoom and this op can never drift apart).
 */
export function zoomAroundCenter(cam: Camera, viewport: Viewport, targetZoom: number, minZoom = 0.01, maxZoom = 100): Camera {
  return zoomAroundPoint(cam, { x: viewport.w / 2, y: viewport.h / 2 }, targetZoom, minZoom, maxZoom);
}
