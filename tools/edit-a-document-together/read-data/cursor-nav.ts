// packages/documents/read-data/cursor-nav.ts
//
// The spatial-cursor navigation PRIMITIVE (L069) — the ONE blind, pure, engine-free resolver that
// arrow-key caret nav, backspace-adjacent, and marquee-extend all configure with a DATA direction
// vector. It picks the nearest block in a DIRECTION by GEOMETRY over rendered rects — NOT by
// next-sibling index (which is the L055 root cause of broken nav: blocks live in an arbitrary
// 2D / nested / multi-directional layout, so "next in reading order" != "next in the direction the
// user pressed"). Zero I/O, zero React, zero engine — unit-testable in isolation.
//
// Directions are DATA (a {dx,dy} vector), never a code enum: up {0,-1}, down {0,1}, left {-1,0},
// right {1,0}, or ANY diagonal / arbitrary vector — the scorer is dimension-generic (add a dz for a
// 3D layout and the same math holds). A new direction is a DATA row, zero engine change
// (enum-dissolution / L090).

export type Rect = { x: number; y: number; w: number; h: number };
export type Candidate = { id: string; rect: Rect };
/** A DATA unit(ish) vector. Magnitude is irrelevant — it is normalized here. */
export type Direction = { dx: number; dy: number };

/** The preserved caret "goal" line — goal-column x for vertical moves, goal-row y for horizontal
 *  moves — so ArrowDown from mid-line lands at the SAME x on the next block (not its start/end). */
export type Goal = { x?: number; y?: number };

// How hard off-axis misalignment is penalized relative to along-axis distance. >1 means a
// well-aligned farther block beats a nearer but wildly-misaligned one — the property that makes
// goal-column preservation feel right (you go "down the column", not to whatever is closest).
const OFF_AXIS_WEIGHT = 2;

/**
 * Resolve the nearest candidate strictly in `dir` from `from`, biased toward the `goal` line so the
 * caret's visual column/row is preserved. Returns the candidate id, or null when nothing lies in
 * that direction (the caller then knows it is at the edge — e.g. top block, ArrowUp → stay).
 */
export function resolveInDirection(
  from: Rect,
  dir: Direction,
  candidates: readonly Candidate[],
  goal?: Goal,
): string | null {
  const fromCx = from.x + from.w / 2;
  const fromCy = from.y + from.h / 2;
  const goalX = goal?.x ?? fromCx;
  const goalY = goal?.y ?? fromCy;
  const len = Math.hypot(dir.dx, dir.dy) || 1;
  const ux = dir.dx / len;
  const uy = dir.dy / len;

  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const s = scoreCandidate(c, goalX, goalY, ux, uy);
    if (s < bestScore) {
      bestScore = s;
      best = c.id;
    }
  }
  return best;
}

// Score one candidate for a move: distance ALONG the direction ray (from the goal caret point) plus
// the PERPENDICULAR distance off that ray, weighted. Fully direction-generic — the ray is defined by
// the unit vector (ux,uy), so up/down/left/right/diagonal/3D all use the same math (no vertical vs
// horizontal branch). A candidate not in the direction (along <= epsilon) scores Infinity.
function scoreCandidate(c: Candidate, goalX: number, goalY: number, ux: number, uy: number): number {
  const cx = c.rect.x + c.rect.w / 2;
  const cy = c.rect.y + c.rect.h / 2;
  const along = (cx - goalX) * ux + (cy - goalY) * uy; // projection onto the direction (center)
  if (along <= 1) return Infinity;
  // Perpendicular distance from the GOAL point to the candidate's RECT along the off-axis (not the
  // center) — so a wide block whose span CONTAINS the goal column scores perp 0 and beats a narrower
  // block whose center happens to be closer (the goal-column-preservation property). Generic: projects
  // the rect corners onto the off-axis, so up/down/left/right/diagonal all use the same interval math.
  const perp = offAxisDistanceToRect(c.rect, goalX, goalY, -uy, ux);
  return along + perp * OFF_AXIS_WEIGHT;
}

// Distance from the goal point to the candidate rect measured along the off-axis unit vector (ox,oy):
// project the rect's four corners onto that axis to get an interval [lo,hi], then the goal's distance
// to that interval (0 when the goal's off-axis coordinate falls within the rect's span).
function offAxisDistanceToRect(rect: Rect, goalX: number, goalY: number, ox: number, oy: number): number {
  const gp = goalX * ox + goalY * oy;
  const c1 = rect.x * ox + rect.y * oy;
  const c2 = (rect.x + rect.w) * ox + rect.y * oy;
  const c3 = rect.x * ox + (rect.y + rect.h) * oy;
  const c4 = (rect.x + rect.w) * ox + (rect.y + rect.h) * oy;
  const lo = Math.min(c1, c2, c3, c4);
  const hi = Math.max(c1, c2, c3, c4);
  return gp < lo ? lo - gp : gp > hi ? gp - hi : 0;
}

/** One vertical-move "run": the goal column the caret aims for, and where the caret actually LANDED
 *  after the last move (which may be clamped by a narrow block). */
export type GoalRun = { column: number; landedX: number };

/**
 * Decide the goal column for a vertical caret move (N1 goal-column preservation). Continues the current
 * run — reusing the sticky `column` — only when the incoming caret x is still where the last vertical
 * move left it (within `tolerance`); otherwise the user has typed, clicked, or moved horizontally, so a
 * FRESH column starts at `incomingX`. Pure, so the drift-prevention logic is unit-tested independent of
 * the DOM (getBoundingClientRect / caretPositionFromPoint) the surface wraps around it.
 */
export function resolveGoalColumn(prev: GoalRun | null, incomingX: number, tolerance = 3): number {
  if (prev && Math.abs(incomingX - prev.landedX) <= tolerance) return prev.column;
  return incomingX;
}

/** True when two axis-aligned rects overlap (touching edges do not count). */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Every candidate whose rect intersects the marquee rect — the blind resolver behind drag-select
 * (N4). Same Rect model as directional nav, so marquee and arrow nav share ONE spatial primitive
 * (L063). The marquee is a DATA rect {x,y,w,h}; the op over the returned ids (delete/move/arrange) is
 * chosen by the caller, never named here.
 */
export function candidatesInRect(marquee: Rect, candidates: readonly Candidate[]): string[] {
  return candidates.filter((c) => rectsIntersect(marquee, c.rect)).map((c) => c.id);
}

/** Normalize a drag from (x0,y0)→(x1,y1) into a positive-extent rect (the marquee box). */
export function marqueeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
}

/**
 * A diagnostic dump of the blind geometry model the cursor navigates over — for the DATA-driven
 * nav (no hidden state): every candidate's rect + its along/off score for a given move, sorted best
 * first. Pure; the surface can console.log this to prove nav is geometry, not sibling-index.
 */
export function navDiagnostics(
  from: Rect,
  dir: Direction,
  candidates: readonly Candidate[],
  goal?: Goal,
): Array<{ id: string; along: number; off: number; score: number; chosen: boolean }> {
  const fromCx = from.x + from.w / 2;
  const fromCy = from.y + from.h / 2;
  const goalX = goal?.x ?? fromCx;
  const goalY = goal?.y ?? fromCy;
  const len = Math.hypot(dir.dx, dir.dy) || 1;
  const ux = dir.dx / len;
  const uy = dir.dy / len;
  const chosen = resolveInDirection(from, dir, candidates, goal);
  const rows = candidates.map((c) => {
    const cx = c.rect.x + c.rect.w / 2;
    const cy = c.rect.y + c.rect.h / 2;
    const along = (cx - goalX) * ux + (cy - goalY) * uy;
    const off = offAxisDistanceToRect(c.rect, goalX, goalY, -uy, ux);
    const score = along <= 1 ? Infinity : along + off * OFF_AXIS_WEIGHT;
    return { id: c.id, along, off, score, chosen: c.id === chosen };
  });
  return rows.sort((a, b) => a.score - b.score);
}
