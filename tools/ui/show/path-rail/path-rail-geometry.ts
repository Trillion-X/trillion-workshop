// packages/ui/show/path-rail/path-rail-geometry.ts
//
// =============================================================================
// PURPOSE
// =============================================================================
//
// Pure geometry for the winding "learning path" (Duolingo-style). Given a count
// of nodes, produce the horizontal offset (in px) for each node so the column
// reads as a gently oscillating serpentine centerline. Separated from the React
// component so the winding math is unit-testable with zero DOM.
//
// =============================================================================
// NON-NEGOTIABLE INVARIANTS
// =============================================================================
//
// 1. Pure + total: same input -> identical output, never throws.
// 2. No domain vocabulary — this is geometry, it knows nothing about lessons,
//    topic, levels, or status. It maps an index to a horizontal offset.
// 3. offsets[0] is always 0 (the path starts on the centerline).
// 4. Every offset is within [-amplitude, +amplitude].
//
// =============================================================================
// =============================================================================
//
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

export interface WindingConfig {
  /** Max horizontal swing from the centerline, in px. Default 64. */
  amplitude?: number;
  /** Nodes per full left→right→left oscillation. Default 4. */
  period?: number;
}

const DEFAULT_AMPLITUDE = 64;
const DEFAULT_PERIOD = 4;

/**
 * Horizontal offsets (px) for `count` nodes on a sinusoidal winding centerline.
 * offsets[0] === 0; values oscillate within [-amplitude, +amplitude]. A non-
 * positive count yields []. A non-finite/non-positive period falls back to the
 * default so the function is total.
 */
export function windingOffsets(count: number, config: WindingConfig = {}): number[] {
  const amplitude = Number.isFinite(config.amplitude) ? (config.amplitude as number) : DEFAULT_AMPLITUDE;
  const periodRaw = Number.isFinite(config.period) ? (config.period as number) : DEFAULT_PERIOD;
  const period = periodRaw > 0 ? periodRaw : DEFAULT_PERIOD;
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;

  const offsets: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const raw = amplitude * Math.sin((2 * Math.PI * index) / period);
    // Round to 3 dp so layout is deterministic and snapshot-stable.
    offsets.push(Math.round(raw * 1000) / 1000);
  }
  return offsets;
}

/** One straight connector spanning the vertical gap between two adjacent nodes.
 *  `fromX`/`toX` are the horizontal centers (px, from the winding offsets) of the
 *  upper and lower node; `length`/`angleDeg` place a single rotated rule between
 *  them. Geometry only — it knows nothing of status, tone, or dashes. */
export interface ConnectorSegment {
  fromX: number;
  toX: number;
  length: number;
  angleDeg: number;
}

/**
 * Connector segments for `offsets.length` nodes stacked `gap` px apart: one
 * segment per adjacent pair (so N nodes → N-1 segments; <2 nodes → []). Each
 * segment is the hypotenuse from the upper node's center (fromX, 0) to the lower
 * node's center (toX, gap). Pure + total: same input → identical output, never
 * throws. A non-finite/negative gap is treated as 0 (vertical-only spacing).
 */
export function connectorSegments(offsets: number[], gap: number): ConnectorSegment[] {
  const dy = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const segs: ConnectorSegment[] = [];
  for (let i = 0; i < offsets.length - 1; i += 1) {
    const fromX = offsets[i] ?? 0;
    const toX = offsets[i + 1] ?? 0;
    const dx = toX - fromX;
    const length = Math.round(Math.hypot(dx, dy) * 1000) / 1000;
    const angleDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI * 1000) / 1000;
    segs.push({ fromX, toX, length, angleDeg });
  }
  return segs;
}
