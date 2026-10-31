// tools/turn-frames-into-slides/read-data/finite-coord.ts
//
// The board-geometry SANITIZATION SSOT (pure leaf, zero I/O). Every board coordinate
// (x/y/w/h, in world units) that enters a pure geometry algorithm — align, distribute,
// arrange, snap, SVG-export transform, producer ingestion — must first pass through
// `finiteCoord`. Two failure modes it closes, both REACHABLE from untrusted board DATA
// (a persisted/corrupted log record or an AI/process producer payload, neither of which
// runs the write-path validators):
//
//   1. NON-FINITE input (NaN / ±Infinity) → poisons every min/max/sum it touches
//      (`Math.min(x, NaN) === NaN`), so ONE bad item makes the WHOLE align/distribute
//      emit NaN patches, corrupting the items that were fine.
//   2. FINITE-BUT-HUGE input (e.g. `Number.MAX_VALUE`) → OVERFLOWS to ±Infinity during
//      ordinary arithmetic (`b.x + b.w`, a span, a pitch) even though each input is
//      "finite", again serializing a non-finite position/size.
//
// `finiteCoord` collapses both: a non-finite value falls back to `fallback` (default 0),
// and a finite value is clamped to ±`BOARD_COORD_LIMIT`. For any REAL board coordinate
// (well within ±10 million world units) it is a BYTE-IDENTICAL no-op, so it never changes
// a legitimate layout — it only defuses pathological/hostile geometry. Fail closed.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/**
 * The world-unit sanity bound for a board coordinate. No real board spans anywhere near
 * ±10 million units; the bound exists purely so that sums/products of a bounded selection
 * of coordinates can never overflow a double to ±Infinity (10M × a selection of ≤ millions
 * of items still stays many orders of magnitude below `Number.MAX_VALUE`).
 */
export const BOARD_COORD_LIMIT = 1e7;

/**
 * Sanitize one board coordinate to a FINITE, bounded value. A non-finite input (NaN /
 * ±Infinity) becomes `fallback`; a finite input is clamped to ±{@link BOARD_COORD_LIMIT}.
 * A no-op for every real coordinate. This is the ONE place the finite-geometry decision
 * lives, so align/distribute/arrange/snap/export all agree and none can be poisoned.
 */
export function finiteCoord(v: number, fallback = 0): number {
  if (!Number.isFinite(v)) return fallback;
  return v < -BOARD_COORD_LIMIT ? -BOARD_COORD_LIMIT : v > BOARD_COORD_LIMIT ? BOARD_COORD_LIMIT : v;
}
