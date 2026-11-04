// packages/group/show/rotated-transform.ts
//
// Rotation-aware geometry for the board. A board item is stored as a top-left
// (x,y) + size (w,h) + an optional rotation θ (degrees), and rendered with
// `transform: translate(x,y) rotate(θ)` about its CENTER. Resizing such an item by
// dragging an edge/corner handle must (a) grow along the item's OWN (rotated) axes,
// and (b) keep the OPPOSITE handle pinned in world space.
//
// This leaf is a thin coordinate-frame WRAPPER around the existing axis-aligned
// `applyResizeGeom` (the resize SSOT) — it never re-implements the resize math:
//   1. rotate the world pointer delta into the item's local frame  (R(-θ))
//   2. run `applyResizeGeom` in local coords (new local top-left + size)
//   3. move the center by R(+θ)·(local-center shift) and convert back to top-left
// At θ=0 this reduces EXACTLY to `applyResizeGeom`. Pure trig, zero I/O — verified
// by unit tests (θ=0 identity + opposite-handle pin-invariance).

import { applyResizeGeom, type ResizeEdge } from '../../ui';
import { finiteCoord } from '../read-data/finite-coord';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Vec {
  x: number;
  y: number;
}

/** Rotate a vector by `rad` radians: [cos -sin; sin cos]·v. */
export function rotateVec(v: Vec, rad: number): Vec {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/** Rotate a point `p` about a `pivot` by `rad` radians (orbit). Used by group
 *  rotation: each selected item's centre orbits the selection's centre, while the
 *  item also spins on its own axis by the same angle. `rad = 0` is the identity. */
export function orbitPoint(p: Vec, pivot: Vec, rad: number): Vec {
  const rv = rotateVec({ x: p.x - pivot.x, y: p.y - pivot.y }, rad);
  return { x: pivot.x + rv.x, y: pivot.y + rv.y };
}

/**
 * Constrain a CORNER resize delta so the item keeps its aspect ratio (Shift-resize).
 * Only corners (`edge.length === 2`) are constrained — a side edge changes one axis,
 * for which aspect-lock is ambiguous, so it passes through unchanged. The dominant drag
 * axis (the one the user pushes hardest, measured relative to the item's size) drives
 * BOTH axes proportionally, so the corner follows the item's diagonal and Δw/Δh stays
 * equal to w/h. The delta is in the item's LOCAL frame (the caller un-rotates first).
 */
export function constrainAspectDelta(edge: ResizeEdge, d: Vec, w: number, h: number): Vec {
  // `w > 0`/`h > 0` (not `<= 0`) also rejects a NaN size (untrusted item geometry) — a NaN would make
  // `gw / w` = NaN and poison the constrained delta; fail closed to the unconstrained `d`.
  if (edge.length !== 2 || !(w > 0) || !(h > 0)) return d;
  // Signed growth of each dimension for this corner (which pointer direction grows it).
  const gw = edge.includes('e') ? d.x : -d.x;
  const gh = edge.includes('s') ? d.y : -d.y;
  const sW = gw / w;
  const sH = gh / h;
  const s = Math.abs(sW) >= Math.abs(sH) ? sW : sH; // dominant axis drives both
  const gw2 = s * w;
  const gh2 = s * h;
  return {
    x: edge.includes('e') ? gw2 : -gw2,
    y: edge.includes('s') ? gh2 : -gh2,
  };
}

/**
 * Resize a (possibly rotated) rect by dragging `edge`, given a WORLD-space pointer
 * delta. Returns the new top-left + size. The opposite handle stays fixed in world.
 * `thetaDeg` is the item's rotation in degrees (0 → identical to `applyResizeGeom`).
 */
export function resizeRotated(
  rect: Rect,
  thetaDeg: number,
  edge: ResizeEdge,
  dWorld: Vec,
  minW: number,
  minH: number,
  lockAspect = false,
): Rect {
  const theta = (thetaDeg * Math.PI) / 180;
  // 1. world delta → local (box) frame.
  let dLocal = rotateVec(dWorld, -theta);
  // 1a. optional aspect-lock (Shift on a corner): constrain the LOCAL delta so the
  //     item grows along its diagonal. No-op for side edges / when not locking.
  if (lockAspect) dLocal = constrainAspectDelta(edge, dLocal, rect.w, rect.h);
  // 2. axis-aligned resize in local coords (base at local origin).
  const local = applyResizeGeom(edge, { x: 0, y: 0, w: rect.w, h: rect.h }, dLocal.x, dLocal.y, minW, minH);
  // 3. local-frame center shift → world; recompute top-left from the new center.
  const dCenterLocal: Vec = {
    x: local.x + local.w / 2 - rect.w / 2,
    y: local.y + local.h / 2 - rect.h / 2,
  };
  const dCenterWorld = rotateVec(dCenterLocal, theta);
  const cx = rect.x + rect.w / 2 + dCenterWorld.x;
  const cy = rect.y + rect.h / 2 + dCenterWorld.y;
  // Output is persisted via patchItem. An untrusted `thetaDeg` (NaN -> Math.cos(NaN) = NaN) or an
  // untrusted rect coord (MAX_VALUE) would otherwise write a NaN/huge rect. finiteCoord each field.
  return {
    x: finiteCoord(cx - local.w / 2),
    y: finiteCoord(cy - local.h / 2),
    w: finiteCoord(local.w),
    h: finiteCoord(local.h),
  };
}

/** The world position of an edge/corner handle of a rotated rect (handle midpoints
 *  in local frame, rotated about the center) — used by tests and the rotate handle. */
export function handleWorldPos(rect: Rect, thetaDeg: number, edge: ResizeEdge): Vec {
  const theta = (thetaDeg * Math.PI) / 180;
  const hx = (edge.includes('w') ? -1 : edge.includes('e') ? 1 : 0) * (rect.w / 2);
  const hy = (edge.includes('n') ? -1 : edge.includes('s') ? 1 : 0) * (rect.h / 2);
  const r = rotateVec({ x: hx, y: hy }, theta);
  return { x: rect.x + rect.w / 2 + r.x, y: rect.y + rect.h / 2 + r.y };
}

/** The world-space center of a rect. */
export function rectCenter(rect: Rect): Vec {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** The OPPOSITE handle of an edge/corner (for pin-invariance checks + anchoring). */
export function oppositeEdge(edge: ResizeEdge): ResizeEdge {
  const flip: Record<string, string> = { n: 's', s: 'n', e: 'w', w: 'e' };
  return ([...edge].map((c) => flip[c]).join('') as ResizeEdge);
}
