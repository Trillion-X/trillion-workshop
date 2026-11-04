// packages/group/show/note-autofit.ts
// Note-height derivation from measured content height (#217).

export interface FitNoteHeightOptions {
  readonly minH?: number;
  readonly chrome?: number;
  readonly maxH?: number;
}

// Height a note should take to show `contentHeight` px of text plus chrome, floored at
// minH and optionally capped at maxH. Null for a non-positive measurement (keep size).
export function fitNoteHeight(contentHeight: number, options: FitNoteHeightOptions = {}): number | null {
  if (!(contentHeight > 0) || !Number.isFinite(contentHeight)) return null;
  // `minH` is the CURRENT item height at the call site (`{ minH: item.h }`) — untrusted board geometry.
  // `?? 64` only catches null/undefined, NOT a NaN item.h, so a malformed item would make `Math.max(NaN, …)`
  // NaN → this leaf emits a NaN height. Fail closed to the floor default so the leaf never emits NaN.
  const minH = Number.isFinite(options.minH) ? (options.minH as number) : 64;
  const maxH = options.maxH ?? Number.POSITIVE_INFINITY;
  const chrome = options.chrome ?? 0;
  return Math.min(maxH, Math.max(minH, Math.round(contentHeight + chrome)));
}

// Whether a derived height differs enough from the current to warrant a write. The
// threshold keeps the measure/patch cycle to a single step (once the box fits, the
// next measurement equals the current height).
export function noteHeightChanged(currentH: number, fitH: number | null, threshold = 2): fitH is number {
  return fitH != null && Math.abs(fitH - currentH) >= threshold;
}
