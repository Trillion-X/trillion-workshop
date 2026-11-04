// packages/group/read-data/spatial-nav.ts
//
// Directional spatial navigation — the generative primitive for "move the selection to the node in THIS
// direction". Given the board's node rects, a direction, and a starting point (a node id or a world point),
// it picks the nearest node ahead in that direction. It is the engine behind keyboard node navigation
// (Codex a11y gap #5: canvas nodes were not keyboard-selectable) — Alt+Arrow hops between cards, and a plain
// Arrow on an empty selection enters the board from the viewport centre — but it names nothing about
// keyboards or selection: it is pure geometry over rects, reusable for any directional-move need (roving
// tab order, gamepad focus, "select neighbour"). Pure + deterministic (no clock, no DOM).
//
// Scoring: among nodes strictly AHEAD of the origin along the direction vector, minimise
// `forwardDistance + 2·perpendicularOffset` — so a well-aligned node further along beats a badly-aligned
// node slightly nearer (the standard spatial-nav feel: pressing Right lands on the thing to your right,
// not a thing that is mostly up-and-slightly-right).

/** A node's world-space box (the id is whatever the caller keys selection by — here, a memberId). */
export interface NavRect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export type NavDir = 'left' | 'right' | 'up' | 'down';

interface Pt {
  readonly x: number;
  readonly y: number;
}

const DIR_VEC: Record<NavDir, Pt> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

const centerOf = (r: NavRect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/**
 * The nearest node to move to when heading `dir` from `from`. `from` is a node id (its centre is the origin
 * and that node is excluded) or a world point (used verbatim, nothing excluded); omit it to ENTER from the
 * direction's trailing edge (pressing Right with no origin → the left-most node). Returns null when nothing
 * lies ahead (or the board is empty). Pure + deterministic (ties break by input order).
 */
export function nearestInDirection(rects: readonly NavRect[], dir: NavDir, from?: string | Pt): string | null {
  if (rects.length === 0) return null;
  const v = DIR_VEC[dir];

  let origin: Pt | null = null;
  let excludeId: string | null = null;
  if (typeof from === 'string') {
    const r = rects.find((x) => x.id === from);
    if (r) {
      origin = centerOf(r);
      excludeId = from;
    }
  } else if (from) {
    origin = from;
  }

  // No origin → ENTRY: the first node you'd meet coming from the trailing edge = the one with the smallest
  // projection along the direction vector (Right → left-most, Down → top-most).
  if (!origin) {
    let best: string | null = null;
    let bestProj = Infinity;
    for (const r of rects) {
      const c = centerOf(r);
      const proj = c.x * v.x + c.y * v.y;
      if (proj < bestProj) {
        bestProj = proj;
        best = r.id;
      }
    }
    return best;
  }

  let best: string | null = null;
  let bestScore = Infinity;
  for (const r of rects) {
    if (r.id === excludeId) continue;
    const c = centerOf(r);
    const dx = c.x - origin.x;
    const dy = c.y - origin.y;
    const along = dx * v.x + dy * v.y; // forward distance; must be strictly ahead
    if (along <= 0) continue;
    const perp = Math.abs(dx * v.y - dy * v.x); // perpendicular offset (|cross product|)
    const score = along + perp * 2;
    if (score < bestScore) {
      bestScore = score;
      best = r.id;
    }
  }
  return best;
}
