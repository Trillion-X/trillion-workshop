// packages/group/show/resolve-overlaps.ts
//
// The overlap-removal leaf (cont.22) — pure, zero I/O, framework-agnostic. Nudges a set of AABB
// boxes apart so none overlap (with a gap), while PRESERVING the rough layout — the distinct
// counterpart to the arrange primitives (grid/masonry/sort/facet/matrix) which impose a NEW
// structure. This one keeps everything roughly where it is and only separates the collisions:
// "I pasted a stack of stickies — spread them out." Deterministic + terminating (fixed iteration
// cap, index-ordered passes, symmetric half-MTV pushes → centroid-preserving). Blind to what the
// boxes mean (L090). Pure so the geometry is unit-tested; the panel applies the returned positions.

export interface OverlapBox {
  readonly memberId: string;
  readonly x: number; // top-left
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** Immovable (e.g. a locked item): it stays put and pushes the OTHER box the full amount. */
  readonly pinned?: boolean;
}

export interface OverlapPosition {
  readonly memberId: string;
  readonly x: number;
  readonly y: number;
}

export interface ResolveOverlapsOptions {
  readonly gap?: number; // min empty space between separated boxes (default 12)
  readonly maxPasses?: number; // relaxation cap (default 200) — the termination guarantee
}

interface Live {
  readonly memberId: string;
  cx: number; // centre (we relax on centres, emit top-left)
  cy: number;
  readonly hw: number; // half-width
  readonly hh: number; // half-height
  readonly pinned: boolean;
  readonly i: number; // stable index for deterministic tie-breaking
}

/**
 * Separate `boxes` so no two overlap (leaving `gap` between them), moving each as little as
 * possible. Returns one position per input box (same memberId set); boxes that never collide are
 * returned unchanged. Empty/one box → unchanged.
 *
 * Method (Codex-converged, empirically tuned): Gauss-Seidel relaxation on box CENTRES. Each pass
 * walks every pair (i<j) in index order and IMMEDIATELY separates any that overlap — applying the
 * push before the next pair is examined. Immediate application (vs accumulating a whole pass) is
 * what breaks the symmetry of a perfectly-aligned pile: once earlier boxes shift, later pairs see
 * an asymmetric field and cascade apart (a Jacobi accumulate-then-apply STALLS on such symmetric
 * grids). Each push is along the axis of LEAST penetration — the smallest separating nudge, which
 * preserves the rough layout (vs a center-to-center shove that reshapes clusters). Movable boxes
 * split the push evenly (centroid-preserving); a pinned box holds and the other takes the whole
 * push. Coincident-centre ties break by index → deterministic sign. Damping is deliberately 1.0:
 * damped moves were measured to STALL these near-symmetric configs, not stabilise them. Stops when
 * a pass finds no overlap (converged) or at `maxPasses` (the hard termination bound → best effort).
 * O(passes · n²); tight aligned grids can need ~1000 passes (n≤~100 → still sub-millisecond).
 */
export function resolveOverlaps(boxes: readonly OverlapBox[], opts?: ResolveOverlapsOptions): OverlapPosition[] {
  // Sanitize numeric options to FINITE defaults. `?? default` only catches null/undefined, so a NaN
  // `gap` would poison overlapX/overlapY into NaN, and `NaN <= EPS` is false → the separation runs on
  // NaN and every position becomes NaN. A non-finite `maxPasses` would either no-op (< NaN is false)
  // or spin unbounded (< Infinity). Fail closed to the defaults.
  const gap = Number.isFinite(opts?.gap) && (opts!.gap as number) >= 0 ? (opts!.gap as number) : 12;
  const maxPasses = Number.isFinite(opts?.maxPasses) && (opts!.maxPasses as number) > 0 ? Math.floor(opts!.maxPasses as number) : 1200;
  const live: Live[] = boxes.map((b, i) => ({
    memberId: b.memberId,
    cx: b.x + b.w / 2,
    cy: b.y + b.h / 2,
    hw: b.w / 2,
    hh: b.h / 2,
    pinned: b.pinned === true,
    i,
  }));

  const EPS = 1e-6;
  const n = live.length;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let moved = false;
    for (let a = 0; a < n; a += 1) {
      for (let b = a + 1; b < n; b += 1) {
        const A = live[a];
        const B = live[b];
        if (A.pinned && B.pinned) continue;
        const dx = B.cx - A.cx;
        const dy = B.cy - A.cy;
        const overlapX = A.hw + B.hw + gap - Math.abs(dx);
        const overlapY = A.hh + B.hh + gap - Math.abs(dy);
        if (overlapX <= EPS || overlapY <= EPS) continue; // separated on ≥1 axis → no collision
        moved = true;

        // Separate along the axis of LEAST penetration; ties (coincident centres) → index sign.
        let px = 0;
        let py = 0;
        if (overlapX < overlapY) px = (dx > 0 ? 1 : dx < 0 ? -1 : A.i < B.i ? -1 : 1) * overlapX;
        else py = (dy > 0 ? 1 : dy < 0 ? -1 : A.i < B.i ? -1 : 1) * overlapY;

        // Apply immediately (Gauss-Seidel). Pinned box holds; the other takes the whole push.
        if (A.pinned) {
          B.cx += px;
          B.cy += py;
        } else if (B.pinned) {
          A.cx -= px;
          A.cy -= py;
        } else {
          A.cx -= px / 2;
          A.cy -= py / 2;
          B.cx += px / 2;
          B.cy += py / 2;
        }
      }
    }
    if (!moved) break; // converged
  }

  return live.map((l) => ({ memberId: l.memberId, x: l.cx - l.hw, y: l.cy - l.hh }));
}
