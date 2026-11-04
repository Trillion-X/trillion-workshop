// packages/group/do-work/attribute-consistency.ts
//
// ATTRIBUTE CONSISTENCY — the board's visual-RHYTHM primitive (b124). Balance (b119) measures WHERE cards sit;
// this measures whether they SHARE a rhythm — are the cards a consistent size, or a noisy jumble of big and
// tiny? A board of same-sized cards reads polished; wildly varied sizes read as clutter.
//
// The measure is the coefficient of variation (spread ÷ average) turned into a 0..1 consistency score
// (1 = perfectly uniform). WHICH attribute (area / width / height / aspect-ratio) is DATA, not a branch:
// `SIZE_MEASURES` is an injected-capability catalog (L069/L090) — a new attribute is one row, zero engine code.
// Pure leaf: deterministic, `finiteCoord`-guarded, zero I/O.

import { finiteCoord } from '../read-data/finite-coord';

/** A card's footprint. */
export interface SizeRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A per-card numeric attribute to measure consistency over. */
export interface SizeMeasureDef {
  readonly id: string;
  readonly label: string;
  readonly valueOf: (rect: SizeRect) => number;
}

export interface ConsistencyResult {
  readonly id: string;
  readonly label: string;
  /** 0..1, 1 = perfectly uniform. */
  readonly consistency: number;
  /** The raw coefficient of variation (stddev ÷ mean), ≥ 0. */
  readonly cv: number;
}

export interface RhythmReport {
  readonly measures: readonly ConsistencyResult[];
  /** Mean of the per-measure consistency scores, 0..1 (1 = uniform). */
  readonly overall: number;
}

const num = (v: number): number => finiteCoord(v);

/** The mean of a list (0 for empty). */
export function meanOf(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + num(v), 0) / values.length;
}

/** Population standard deviation (0 for empty / single). */
export function stdDevOf(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = meanOf(values);
  const variance = values.reduce((s, v) => s + (num(v) - m) ** 2, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
}

/**
 * Consistency of a set of values: `1 - min(1, stddev/mean)`, bounded [0,1] — 1 when every value is identical,
 * approaching 0 as the spread rivals the average. Empty / single / non-positive mean → 1 (nothing to vary).
 * `cv` (the raw coefficient of variation) is returned alongside for callers that want the ratio.
 */
export function consistencyOf(values: readonly number[]): { consistency: number; cv: number } {
  if (values.length < 2) return { consistency: 1, cv: 0 };
  const m = meanOf(values);
  if (m <= 0) return { consistency: 1, cv: 0 };
  const cv = stdDevOf(values) / m;
  return { consistency: Math.max(0, Math.min(1, 1 - cv)), cv };
}

/**
 * The DATA catalog of size attributes (L069/L090). Each reads one number off a rect:
 * - `area`: w·h — the dominant "are these cards the same size" signal.
 * - `width` / `height`: catches boards uniform on one axis but not the other.
 * - `aspect`: w/h — catches a mix of tall and wide cards even at similar areas.
 * A new attribute is one row; nothing else changes.
 */
export const SIZE_MEASURES: readonly SizeMeasureDef[] = [
  { id: 'area', label: 'Area', valueOf: (r) => Math.max(0, num(r.w)) * Math.max(0, num(r.h)) },
  { id: 'width', label: 'Width', valueOf: (r) => Math.max(0, num(r.w)) },
  { id: 'height', label: 'Height', valueOf: (r) => Math.max(0, num(r.h)) },
  { id: 'aspect', label: 'Aspect', valueOf: (r) => (num(r.h) > 0 ? Math.max(0, num(r.w)) / num(r.h) : 0) },
];

/** Look up a measure by id, falling back to the first (the maximally-capable default, L083). */
export function sizeMeasureById(id: string | undefined, measures: readonly SizeMeasureDef[] = SIZE_MEASURES): SizeMeasureDef {
  return measures.find((m) => m.id === id) ?? measures[0];
}

/**
 * Score how consistent the board's card sizes are, per attribute + an overall mean. 0 or 1 card is trivially
 * consistent (overall 1). Deterministic, bounded [0,1].
 */
export function analyzeRhythm(rects: readonly SizeRect[], measures: readonly SizeMeasureDef[] = SIZE_MEASURES): RhythmReport {
  if (rects.length < 2) {
    return { measures: measures.map((m) => ({ id: m.id, label: m.label, consistency: 1, cv: 0 })), overall: 1 };
  }
  const results = measures.map((m) => {
    const { consistency, cv } = consistencyOf(rects.map((r) => m.valueOf(r)));
    return { id: m.id, label: m.label, consistency, cv };
  });
  const overall = results.length ? results.reduce((s, r) => s + r.consistency, 0) / results.length : 1;
  return { measures: results, overall };
}

/** Score band → colour + word (green ≥ 0.8, amber ≥ 0.55, else red). */
export function rhythmBand(overall: number): { color: string; ink: string; label: string } {
  if (overall >= 0.8) return { color: '#dcfce7', ink: '#166534', label: 'Consistent sizes' };
  if (overall >= 0.55) return { color: '#fef9c3', ink: '#854d0e', label: 'Somewhat mixed' };
  return { color: '#fee2e2', ink: '#991b1b', label: 'Mixed sizes' };
}
