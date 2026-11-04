// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/get-path.ts.
// packages/progression-evaluator/read-data/get-path.ts
//
// =============================================================================
// PURPOSE — the ONE canonical machine-readable path walker (SSOT / L088 bedrock)
// =============================================================================
//
// "Read a value from an object by a path ARRAY, undefined if any segment is
// missing" is a single pure primitive. It was independently re-implemented in
// FOUR places (derive-measure's exported getPath, and local copies in
// measure-ops via that import, measure-projection-materializer, and
// cohort-stitch). They were byte-for-byte equivalent — which is exactly how the
// `band` primitive started before one copy silently DIVERGED into a bug. This
// leaf is the bedrock so a path walk has ONE definition and cannot drift: every
// consumer imports it, no file re-derives it.
//
// It carries ZERO dependencies (no FactRecord, no measure types) so ANY module
// can import it without pulling in the measure reducer (L096 minimize coupling /
// L106 independent-inventor test — cohort stitching does not need to know about
// the measure engine to walk a path).
//
// Semantics: an empty or omitted path returns the object itself; otherwise walk
// each segment, returning undefined the moment a segment is absent or the cursor
// is not a traversable object. Pure + total: zero I/O, never throws. Accepts a
// `readonly string[]` so both mutable and readonly path arrays pass.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

/** Read the value at `path` within `obj`. Empty/omitted path -> `obj`; a missing
 *  segment (or a non-object cursor) -> `undefined`. Pure, total, zero-dep. */
export function getPath(obj: unknown, path: readonly string[] | undefined): unknown {
  if (!path || path.length === 0) return obj;
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
