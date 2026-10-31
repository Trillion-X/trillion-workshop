// tools/turn-frames-into-slides/read-data/crop-rect.ts
//
// Normalized image crop geometry for the board. A board image can carry a crop
// rectangle `{x,y,w,h}` in 0..1 fractions of the SOURCE image; the renderer shows
// only that sub-rectangle, scaled to fill the item frame. This leaf owns the pure
// math: the default (full) crop, clamping a crop to the unit square with a usable
// minimum, and resizing a crop handle by REUSING the same axis-aligned
// `applyResizeGeom` the item box uses — crop is "resize, but in the image's
// normalized space, clamped to [0,1]²". Pure trig/clamp, zero I/O — unit-tested.

import { applyResizeGeom, type ResizeEdge } from './resize-geometry.ts';

/** A crop window in normalized source coordinates (0..1). `{0,0,1,1}` = the full image. */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole image — the default when an item carries no crop (render unchanged). */
export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 };

/** The smallest a crop window may be (5% of the source) — keeps it grabbable and
 *  prevents an inverted / zero-area window. */
export const MIN_CROP = 0.05;

/** True when `c` is a usable crop (4 finite numbers, positive size, inside [0,1]²). The unit-square
 *  bounds are now ENFORCED, not just documented: a live crop is always in-unit (clampCrop /
 *  intersectUnit guarantee x>=0, y>=0, x+w<=1, y+h<=1), but a malformed/hostile DATA crop (e.g. an
 *  untrusted capsule with `{x:2, w:0.5}`) would otherwise divide through in svgCropImageRect into an
 *  offscreen/enlarged `<image>` rect. An out-of-unit crop is rejected → the caller renders uncropped. */
export function isCrop(c: unknown): c is Crop {
  if (!c || typeof c !== 'object') return false;
  const r = c as Record<string, unknown>;
  const e = 1e-4; // float tolerance so a full 0..1 crop (x+w === 1) is not rejected
  return (
    typeof r.x === 'number' && Number.isFinite(r.x) && r.x >= -e &&
    typeof r.y === 'number' && Number.isFinite(r.y) && r.y >= -e &&
    typeof r.w === 'number' && Number.isFinite(r.w) && r.w > 0 &&
    typeof r.h === 'number' && Number.isFinite(r.h) && r.h > 0 &&
    (r.x as number) + (r.w as number) <= 1 + e && (r.y as number) + (r.h as number) <= 1 + e
  );
}

/** True when the crop covers the whole image (within epsilon) — render as if uncropped. */
export function isFullCrop(c: Crop): boolean {
  const e = 1e-4;
  return c.x <= e && c.y <= e && c.w >= 1 - e && c.h >= 1 - e;
}

/** Clamp a crop to the unit square by SLIDING it (keeps its size) — for MOVING/panning
 *  a fixed-size window: width/height are pinned to [MIN_CROP,1] first, then the origin is
 *  pulled in so `x+w ≤ 1` and `y+h ≤ 1`. (For an EDGE resize use the edge-intersect inside
 *  {@link resizeCrop}, which caps the dragged edge instead of sliding the whole window.) */
export function clampCrop(c: Crop): Crop {
  const w = Math.min(1, Math.max(MIN_CROP, c.w));
  const h = Math.min(1, Math.max(MIN_CROP, c.h));
  const x = Math.min(1 - w, Math.max(0, c.x));
  const y = Math.min(1 - h, Math.max(0, c.y));
  return { x, y, w, h };
}

/** Clamp a crop to the unit square by INTERSECTING each edge with [0,1] — the dragged
 *  edge stops at the image boundary while the opposite (pinned) edge stays put. This is
 *  the resize semantics (Figma crop): a handle pushed past the edge pins to the edge, it
 *  does NOT drag the whole window. `applyResizeGeom` already pins the opposite edge and
 *  enforces the min size, so intersecting is sufficient and never inverts. */
function intersectUnit(c: Crop): Crop {
  const left = Math.max(0, c.x);
  const top = Math.max(0, c.y);
  const right = Math.min(1, c.x + c.w);
  const bottom = Math.min(1, c.y + c.h);
  return { x: left, y: top, w: Math.max(MIN_CROP, right - left), h: Math.max(MIN_CROP, bottom - top) };
}

/** Resize a crop window by dragging `edge`, given a pointer delta already normalized
 *  into source space (`dx01 = dWorldX / itemW`, `dy01 = dWorldY / itemH`). Reuses the
 *  item-box resize primitive in 0..1 space (which pins the opposite edge + enforces the
 *  min), then intersects with the unit square so the dragged edge stops at the boundary. */
export function resizeCrop(crop: Crop, edge: ResizeEdge, dx01: number, dy01: number): Crop {
  const next = applyResizeGeom(edge, { x: crop.x, y: crop.y, w: crop.w, h: crop.h }, dx01, dy01, MIN_CROP, MIN_CROP);
  return intersectUnit({ x: next.x, y: next.y, w: next.w, h: next.h });
}
