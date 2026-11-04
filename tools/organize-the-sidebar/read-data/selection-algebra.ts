// packages/group/read-data/selection-algebra.ts
//
// SELECTION SET-ALGEBRA — the OPERATOR layer over the four SELECTOR modalities (by analysis `reportSelect`,
// geometry `itemsInRect`, connectivity `growSelection`, attribute `selectMatching`). Each modality PRODUCES a
// set of ids; this COMBINES them, which is what turns a pile of selectors into a real power-user selection:
// "marquee a region, INTERSECT with same-tag 'work', SUBTRACT the ones already done". Without the algebra the
// selectors can only replace each other; with it they compose.
//
// The four binary boolean set operations are closed by Physics (union / intersect / difference / symmetric-
// difference — the meaningful named combinators of two sets), so they are named pure functions; `applySetOp`
// exposes them as a DATA-keyed capability map (`SET_OPS`) so a UI "combine mode" toggle is a string, not a
// branch. Every result is order-preserving (first-seen) and deduped. Pure, deterministic; operates on opaque
// id lists (owns no board vocabulary).

/** Dedupe an id list, preserving first-seen order. */
function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** UNION — every id in ANY list, first-seen order across all lists, deduped. N-ary. */
export function unionIds(...lists: readonly (readonly string[])[]): string[] {
  return dedupe(lists.flat());
}

/** INTERSECT — the ids present in `a` AND every one of `rest`, in `a`'s order, deduped. N-ary (an id survives
 *  only if it is in all operands). With no `rest`, returns `a` deduped. */
export function intersectIds(a: readonly string[], ...rest: readonly (readonly string[])[]): string[] {
  const sets = rest.map((r) => new Set(r));
  return dedupe(a).filter((id) => sets.every((s) => s.has(id)));
}

/** DIFFERENCE — the ids in `a` but NOT in `b`, in `a`'s order, deduped (a − b). */
export function differenceIds(a: readonly string[], b: readonly string[]): string[] {
  const bs = new Set(b);
  return dedupe(a).filter((id) => !bs.has(id));
}

/** SYMMETRIC DIFFERENCE — the ids in exactly ONE of `a`/`b` (a XOR b): a-not-b in a's order, then b-not-a in
 *  b's order, deduped. */
export function symmetricDifferenceIds(a: readonly string[], b: readonly string[]): string[] {
  return unionIds(differenceIds(a, b), differenceIds(b, a));
}

/** COMPLEMENT — the ids in `universe` not in `subset`, in universe order (difference over a known universe).
 *  The id-list form of `box-select`'s `invertSelection` (which takes items); "select everything EXCEPT". */
export function complementIds(universe: readonly string[], subset: readonly string[]): string[] {
  return differenceIds(universe, subset);
}

/** The DATA-keyed combinator map — a UI "combine mode" is one of these string keys, not a code branch (L090). */
export const SET_OPS: Readonly<Record<string, (a: readonly string[], b: readonly string[]) => string[]>> = {
  union: (a, b) => unionIds(a, b),
  intersect: (a, b) => intersectIds(a, b),
  difference: (a, b) => differenceIds(a, b),
  'symmetric-difference': (a, b) => symmetricDifferenceIds(a, b),
};

/** Apply a set operation by DATA key. An unknown key is a fail-safe no-op that keeps the PRIMARY selection `a`
 *  (deduped) unchanged — an unrecognised combine mode never throws and never silently empties the selection. */
export function applySetOp(op: string, a: readonly string[], b: readonly string[]): string[] {
  const fn = Object.prototype.hasOwnProperty.call(SET_OPS, op) ? SET_OPS[op] : undefined;
  return fn ? fn(a, b) : dedupe(a);
}
