// tools/turn-frames-into-slides/read-data/group-resize.ts
//
// The group-resize primitive: scale a SET of item rectangles as ONE unit by
// dragging a handle on their shared selection bounding box — the standard
// multi-select transform in Figma / Excalidraw / Canva (grounded in Mobbin
// canvas references). Pure geometry, no graph/React/I/O — the board wires the
// pointer gesture and folds the result through `patchItem` as one undoable batch.
//
// Configuration of the Selection primitive (#92): a selection is a set; this is
// the set-level transform. Single-item resize keeps its own 8-dir strips; this
// is ONLY engaged when ≥2 items are selected.

import { finiteCoord } from './finite-coord.ts';

/** An axis-aligned rectangle in world space. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The 8 resize handles: 4 corners (2-axis) + 4 edge midpoints (1-axis). */
export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const RESIZE_HANDLES: readonly ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** True for the 4 corner handles (scale on both axes). */
export function isCornerHandle(h: ResizeHandle): boolean {
  return h === 'nw' || h === 'ne' || h === 'se' || h === 'sw';
}

/**
 * Constrain a drag delta to its DOMINANT axis (#179 — Shift-drag axis lock; Figma/FigJam/
 * Miro precision canon). The larger-magnitude component wins and the other is zeroed, so a
 * held-Shift drag stays perfectly horizontal or vertical. A tie keeps horizontal (`dx`).
 * Pure — the board applies this only while Shift is held during a move, reading the live
 * modifier off the pointer event so pressing/releasing Shift mid-drag toggles the lock.
 */
export function constrainToAxis(dx: number, dy: number): { dx: number; dy: number } {
  return Math.abs(dx) >= Math.abs(dy) ? { dx, dy: 0 } : { dx: 0, dy };
}

/** The union (bounding box) of a set of rects, or null for an empty set. */
export function selectionBounds(rects: ReadonlyArray<Rect>): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of rects) {
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x + r.w > maxX) maxX = r.x + r.w;
    if (r.y + r.h > maxY) maxY = r.y + r.h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** The fixed point a drag scales AROUND — the corner/edge opposite the handle. */
export function anchorForHandle(bounds: Rect, handle: ResizeHandle): { x: number; y: number } {
  const left = bounds.x;
  const right = bounds.x + bounds.w;
  const top = bounds.y;
  const bottom = bounds.y + bounds.h;
  switch (handle) {
    case 'nw':
      return { x: right, y: bottom };
    case 'n':
      return { x: left, y: bottom };
    case 'ne':
      return { x: left, y: bottom };
    case 'e':
      return { x: left, y: top };
    case 'se':
      return { x: left, y: top };
    case 's':
      return { x: left, y: top };
    case 'sw':
      return { x: right, y: top };
    case 'w':
      return { x: right, y: top };
  }
}

/** Smallest scale factor allowed — prevents inversion/flip when dragging past the anchor. */
const MIN_SCALE = 0.05;

/**
 * Scale factors produced by dragging `handle` by (dx, dy) world px from the
 * current `bounds`. Edge handles scale one axis (the other stays 1). With
 * `uniform` (Shift), corners scale both axes by the dominant factor (aspect-preserving).
 */
export function scaleForHandleDrag(
  bounds: Rect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  uniform = false,
): { sx: number; sy: number } {
  const w0 = bounds.w || 1;
  const h0 = bounds.h || 1;
  // Which horizontal/vertical direction this handle grows.
  const growsRight = handle === 'ne' || handle === 'e' || handle === 'se';
  const growsLeft = handle === 'nw' || handle === 'w' || handle === 'sw';
  const growsDown = handle === 'sw' || handle === 's' || handle === 'se';
  const growsUp = handle === 'nw' || handle === 'n' || handle === 'ne';

  let sx = 1;
  let sy = 1;
  if (growsRight) sx = (w0 + dx) / w0;
  else if (growsLeft) sx = (w0 - dx) / w0;
  if (growsDown) sy = (h0 + dy) / h0;
  else if (growsUp) sy = (h0 - dy) / h0;

  // `bounds`/`dx`/`dy` derive from UNTRUSTED item geometry — a NaN makes `Math.max(MIN_SCALE, NaN)`
  // = NaN and an Infinity flings the selection. Coerce a non-finite scale to 1 (no-op) before clamp.
  sx = Number.isFinite(sx) ? Math.max(MIN_SCALE, sx) : 1;
  sy = Number.isFinite(sy) ? Math.max(MIN_SCALE, sy) : 1;

  if (uniform && isCornerHandle(handle)) {
    // Aspect-preserving: the axis with the larger relative change drives both.
    const s = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    return { sx: s, sy: s };
  }
  return { sx, sy };
}

/**
 * Scale a set of rects around `anchor` by (sx, sy), clamping each to a minimum
 * size. Both position and size scale, so relative layout is preserved — the
 * whole selection grows/shrinks as one unit.
 */
export function scaleRectsAroundAnchor(
  rects: ReadonlyArray<Rect & { id: string }>,
  anchor: { x: number; y: number },
  sx: number,
  sy: number,
  minW: number,
  minH: number,
): Array<Rect & { id: string }> {
  // Output is written back through patchItem (persisted), so it MUST be finite: an untrusted rect
  // coord, a `sx=Infinity`, or a `0 * Infinity` (item at the anchor) would yield NaN/huge x/y/w/h —
  // note `Math.max(minW, NaN)` = NaN, so the size floor alone does NOT protect. finiteCoord each field.
  return rects.map((r) => ({
    id: r.id,
    x: finiteCoord(Math.round(anchor.x + (r.x - anchor.x) * sx)),
    y: finiteCoord(Math.round(anchor.y + (r.y - anchor.y) * sy)),
    w: Math.max(minW, finiteCoord(Math.round(r.w * sx), minW)),
    h: Math.max(minH, finiteCoord(Math.round(r.h * sy), minH)),
  }));
}
