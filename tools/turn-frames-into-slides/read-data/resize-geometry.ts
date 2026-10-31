// tools/turn-frames-into-slides/read-data/resize-geometry.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure geometry for an 8-direction edge/corner resize of a rectangle. Given the
// grabbed edge, the base rect, and the world-space pointer delta, return the new
// rect. Edges on the top/left side move the origin (x/y) as they resize; bottom/
// right edges only grow w/h. This is the SAME math freeform windows use — lifted
// into `ui/` so any canvas surface (screen-arrangement windows, group board
// items) resizes identically from one source (SSOT), zero per-surface code.
//
// ZERO I/O, ZERO React — a function of numbers. The caller owns persistence.
// =============================================================================

/** The 8 grab points of a rectangle (compass edges + corners). */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** All edges in render order (4 sides + 4 corners). */
export const RESIZE_EDGES: readonly ResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The CSS cursor for each edge (so the surface shows the right affordance on
 *  hover WITHOUT any visible handle chrome — modern infer-to-grab). */
export const RESIZE_CURSOR: Readonly<Record<ResizeEdge, string>> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

/**
 * Apply a resize. `dx`/`dy` are the pointer delta in the rect's own coordinate
 * space (the caller divides screen delta by zoom). `minW`/`minH` clamp the size;
 * when a top/left edge hits the minimum, the origin stops moving (so the opposite
 * edge stays pinned) instead of the box flipping.
 */
export function applyResizeGeom(
  edge: ResizeEdge,
  base: Rect,
  dx: number,
  dy: number,
  minW: number,
  minH: number,
): Rect {
  let { x, y, w, h } = base;
  const grows = (val: number, min: number) => Math.max(min, val);

  const pullWest = () => {
    const nw = grows(w - dx, minW);
    if (nw === minW && dx > 0) { x = x + (w - minW); w = minW; }
    else { x = x + dx; w = nw; }
  };
  const pullNorth = () => {
    const nh = grows(h - dy, minH);
    if (nh === minH && dy > 0) { y = y + (h - minH); h = minH; }
    else { y = y + dy; h = nh; }
  };
  const pushEast = () => { w = grows(w + dx, minW); };
  const pushSouth = () => { h = grows(h + dy, minH); };

  if (edge.includes('e')) pushEast();
  if (edge.includes('s')) pushSouth();
  if (edge.includes('w')) pullWest();
  if (edge.includes('n')) pullNorth();

  return { x, y, w, h };
}
