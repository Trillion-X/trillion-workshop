// packages/group/show/snap-guides.ts
//
// The alignment-snap primitive (Figma/FigJam/Framer "smart guides"). A pure leaf:
// given a MOVING rectangle and a set of PEER rectangles, it returns the small
// offset (dx,dy) that snaps the moving rect's edges/centers onto the nearest peer
// edge/center within a tolerance, plus the guide lines to draw at those matches.
//
// Zero I/O, zero DOM, zero Society vocabulary — universal rectangle geometry. It is
// the generative primitive (L069): the board DRAG is its first caller; resize and
// group-resize are future callers of the SAME function. The handler that consumes
// it (SnapGuideLayer) is blind — it draws whatever guides it is handed (L090).
//
// Per axis, a rectangle exposes THREE candidate lines — its near edge, its center,
// and its far edge. Two rects "align" when any moving candidate coincides with any
// peer candidate. We snap to the single nearest match per axis (smallest correction)
// and emit a guide for every peer that shares that snapped line (so a 3-way
// alignment shows the full set). Axes are independent — you can snap X, Y, or both.

// PEER rects are UNTRUSTED persisted DATA (an imported/shared board). A peer with a
// non-finite or Number.MAX_VALUE coordinate must never poison a guide span or a grid
// correction into NaN/Infinity (the blind renderer would then draw a degenerate line).
// Every value that reaches the drawn output passes through the finiteCoord SSOT.
import { finiteCoord } from '../read-data/finite-coord.ts';

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A line to draw: vertical (`v`, at x=`pos`, spanning y `start..end`) or horizontal. */
export interface SnapGuide {
  orient: 'v' | 'h';
  pos: number;
  start: number;
  end: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

/** The three candidate lines of a rect along one axis: near edge, center, far edge. */
function linesX(r: SnapRect): number[] {
  return [r.x, r.x + r.w / 2, r.x + r.w];
}
function linesY(r: SnapRect): number[] {
  return [r.y, r.y + r.h / 2, r.y + r.h];
}

/**
 * For one axis: find the offset that snaps any of `movingLines` onto the nearest of
 * any peer's lines within `threshold`. Returns the chosen peer-line position (or
 * null if nothing is close) and the correction `delta = peerLine − movingLine`.
 */
function bestAxisSnap(
  movingLines: number[],
  peers: readonly SnapRect[],
  axisLines: (r: SnapRect) => number[],
  threshold: number,
): { pos: number; delta: number } | null {
  let best: { pos: number; delta: number; dist: number } | null = null;
  for (const peer of peers) {
    for (const pl of axisLines(peer)) {
      for (const ml of movingLines) {
        const dist = Math.abs(pl - ml);
        if (dist <= threshold && (best === null || dist < best.dist)) {
          best = { pos: pl, delta: pl - ml, dist };
        }
      }
    }
  }
  return best ? { pos: best.pos, delta: best.delta } : null;
}

/**
 * The guide line at a snapped position: spans the perpendicular extent of `rect`
 * unioned with every peer that shares the snapped line, so the line visibly
 * connects everything that aligned. Shared by both snap callers (L100).
 */
function buildGuide(orient: 'v' | 'h', pos: number, rect: SnapRect, peers: readonly SnapRect[]): SnapGuide {
  const axisLines = orient === 'v' ? linesX : linesY;
  let start = orient === 'v' ? rect.y : rect.x;
  let end = orient === 'v' ? rect.y + rect.h : rect.x + rect.w;
  for (const peer of peers) {
    if (axisLines(peer).some((pl) => pl === pos)) {
      if (orient === 'v') {
        start = Math.min(start, peer.y);
        end = Math.max(end, peer.y + peer.h);
      } else {
        start = Math.min(start, peer.x);
        end = Math.max(end, peer.x + peer.w);
      }
    }
  }
  // A peer sharing the snapped line carries an UNTRUSTED perpendicular coord (peer.y/x + h/w):
  // a NaN poisons `start`/`end` via Math.min/max (NaN wins and sticks), a MAX_VALUE blows the
  // span to ~1e308. Clamp both to finite board coords so the drawn guide is always renderable.
  return { orient, pos: finiteCoord(pos), start: finiteCoord(start), end: finiteCoord(end) };
}

/**
 * Snap `moving` to the peers and return the (dx,dy) correction + the guide lines.
 * `threshold` is in the SAME units as the rects (world units) — the caller divides a
 * screen-pixel radius by the zoom so the snap feels constant on screen.
 */
export function computeSnap(
  moving: SnapRect,
  peers: readonly SnapRect[],
  threshold: number,
): SnapResult {
  if (peers.length === 0) return { dx: 0, dy: 0, guides: [] };

  const snapX = bestAxisSnap(linesX(moving), peers, linesX, threshold);
  const snapY = bestAxisSnap(linesY(moving), peers, linesY, threshold);
  const dx = snapX ? snapX.delta : 0;
  const dy = snapY ? snapY.delta : 0;

  // The snapped rect (post-correction) — guides span its extent unioned with each
  // peer that shares the snapped line, so the line visibly connects what aligned.
  const snapped: SnapRect = { x: moving.x + dx, y: moving.y + dy, w: moving.w, h: moving.h };
  const guides: SnapGuide[] = [];
  if (snapX) guides.push(buildGuide('v', snapX.pos, snapped, peers));
  if (snapY) guides.push(buildGuide('h', snapY.pos, snapped, peers));

  return { dx, dy, guides };
}

/**
 * The snap primitive's SECOND caller (L069): snap the ACTIVE edge(s) of a resizing
 * rect onto peer edges/centers and adjust the size accordingly. The shared core
 * (`bestAxisSnap` + `buildGuide`) is identical to the drag caller — only the moving
 * line-set differs (a resize offers ONLY the dragged edge, and the correction
 * changes size rather than translating). `edge` is parsed generically — "which
 * edges move" lives in the string (`'e'|'w'|'n'|'s'` / corners), never a ui import.
 * A snap that would shrink below `minW`/`minH` is skipped (size stays valid).
 */
/**
 * The snap primitive's THIRD source (L069): snap a MOVING rect's top-left onto the
 * nearest fixed grid cell, returning the (dx,dy) correction. Unlike {@link computeSnap}
 * (which searches PEER lines within a tolerance), the grid is a constant lattice — the
 * correction is a pure rounding of the origin to the nearest `grid` multiple, with no
 * peers and no guides (the grid is already drawn as the board surface, so it needs no
 * magenta line). `grid <= 0` → no correction.
 *
 * The TOP-LEFT is snapped (not the center) so a group drag keeps its relative layout
 * and lands exactly where the one-shot `snapToGrid` batch action would — one grid
 * semantics shared across the drag and the batch op (L100: same result, one rule).
 */
export function snapRectToGrid(moving: SnapRect, grid: number): { dx: number; dy: number } {
  // `grid > 0` alone is not enough: NaN slips past a `<= 0` gate, and an Infinity grid makes
  // `round(x/Infinity) * Infinity` = `0 * Infinity` = NaN. Require a FINITE positive grid. A
  // non-finite origin (`moving.x/y`) is clamped so the rounded target and the correction stay finite.
  if (!(Number.isFinite(grid) && grid > 0)) return { dx: 0, dy: 0 };
  const mx = finiteCoord(moving.x);
  const my = finiteCoord(moving.y);
  const gx = Math.round(mx / grid) * grid;
  const gy = Math.round(my / grid) * grid;
  return { dx: gx - mx, dy: gy - my };
}

export function computeResizeSnap(
  rect: SnapRect,
  edge: string,
  peers: readonly SnapRect[],
  threshold: number,
  minW: number,
  minH: number,
): { rect: SnapRect; guides: SnapGuide[] } {
  if (peers.length === 0) return { rect, guides: [] };
  let { x, y, w, h } = rect;
  const guides: SnapGuide[] = [];

  const right = edge.includes('e');
  const left = edge.includes('w');
  if (right || left) {
    const line = right ? x + w : x;
    const snap = bestAxisSnap([line], peers, linesX, threshold);
    if (snap) {
      if (right) {
        const nw = w + snap.delta;
        if (nw >= minW) { w = nw; guides.push(buildGuide('v', snap.pos, { x, y, w, h }, peers)); }
      } else {
        const nw = w - snap.delta;
        if (nw >= minW) { x = x + snap.delta; w = nw; guides.push(buildGuide('v', snap.pos, { x, y, w, h }, peers)); }
      }
    }
  }

  const bottom = edge.includes('s');
  const top = edge.includes('n');
  if (bottom || top) {
    const line = bottom ? y + h : y;
    const snap = bestAxisSnap([line], peers, linesY, threshold);
    if (snap) {
      if (bottom) {
        const nh = h + snap.delta;
        if (nh >= minH) { h = nh; guides.push(buildGuide('h', snap.pos, { x, y, w, h }, peers)); }
      } else {
        const nh = h - snap.delta;
        if (nh >= minH) { y = y + snap.delta; h = nh; guides.push(buildGuide('h', snap.pos, { x, y, w, h }, peers)); }
      }
    }
  }

  return { rect: { x, y, w, h }, guides };
}
