// packages/group/read-data/board-rollup.ts
//
// The GOAL-ROLLUP primitive (pure leaf): a vision's aggregate progress computed from its sub-goals'
// progress along a tree of relations — "Get fit" rolls up "Run 5k" + "Lose 5kg". A COMPOSITION over the
// metric primitive + the relationship graph, but this leaf is BLIND to both: it takes an injected
// `childrenOf` (who are a node's children — the caller decides the relation kind + direction via DATA, so
// no Society relationKind is named here) and an injected `fractionOf` (a node's own 0..1 progress, or null
// if unmeasured). Physics only: tree reduction, no clock, cycle-safe.
//
// Aggregation is a BRANCH-NORMALIZED recursive mean (per the Codex convergence): each DIRECT child branch
// gets equal say — fraction = mean(defined child rollups) — NOT a flat descendant-leaf average, so a user
// cannot overweight a branch by splitting it into ten tiny grandchildren. An INTERNAL node reflects its
// descendants, NOT its own metric (that is a different question — `ownFraction` is surfaced separately;
// blending them without weights would be fake precision). A node with no measured children falls back to
// its own fraction. Nodes already on the recursion PATH are skipped (cycle-safe, flagged), so a malformed
// graph never loops or double-counts within a path.

/** The rollup verdict for ONE queried node — enough to render an honest "rolls up to X% · N/M tracked" badge. */
export interface RollupResult {
  /** Branch-normalized aggregate of the children's rollups, 0..1 — undefined when no child is measured. */
  readonly fraction?: number;
  /**
   * The node's EFFECTIVE progress as it counts toward a parent: the child rollup `fraction` if it has
   * measured children, else its own metric fraction. This is what a breakdown row shows for each child
   * (a leaf child shows its own progress; an internal child shows its aggregate). Undefined if unmeasured.
   */
  readonly value?: number;
  /** Direct children (whether measured or not). */
  readonly childCount: number;
  /** Direct child branches that contributed a defined rollup — the coverage behind the number. */
  readonly contributingChildCount: number;
  /** The node's OWN progress (its own metric), independent of the rollup — null if unmeasured. */
  readonly ownFraction: number | null;
  /** True iff a cycle was hit while aggregating this node's subtree (diagnostic; those branches contribute nothing). */
  readonly cycleDetected: boolean;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const mean = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / xs.length;

/** A fraction is a FINITE 0..1 value, or "unmeasured" (null). A NaN/Infinity from the injected
 *  metric reader is treated as UNMEASURED — clamp01 alone does NOT reject NaN (`NaN < 0` and
 *  `NaN > 1` are both false → it returns NaN), so one bad accessor would poison the whole aggregate
 *  mean AND be miscounted as a CONTRIBUTING child (claiming coverage the number doesn't have). This
 *  is the ONE place the finite-0..1-or-null decision lives (SSOT), so mean() only ever sees finite
 *  values and contributingChildCount is honest. */
const cleanFraction = (v: number | null): number | null =>
  v === null || !Number.isFinite(v) ? null : clamp01(v);

type Children = (id: string) => readonly string[];
type FractionOf = (id: string) => number | null;

/**
 * Compute, for every node reachable from `root`, its branch-normalized subtree rollup value (null when
 * nothing under/at it is measured), in ONE visit per node via an iterative post-order fold.
 *
 * This replaces a per-path recursion that had TWO reachable failure modes on a graph built from crafted/
 * persisted board connectors (childrenOf is connector-derived and reaches rollupOf live from the panel):
 *   • STACK OVERFLOW on a deep chain (`root <- n1 <- n2 <- …` of tens of thousands) — recursion depth = N.
 *   • EXPONENTIAL BLOWUP on a diamond DAG — the per-path `Set` only deduped a node ALREADY ON THE CURRENT
 *     PATH (a cycle ancestor), NOT a node reached via a sibling branch, so a node shared by K parents was
 *     recomputed along every path → up to 2^depth calls = a hard hang, no deep stack needed.
 * One-visit-per-node (memoized by id, folded bottom-up in reverse-topo order) makes it O(V+E) and removes
 * the call stack. Semantics are preserved: the fold reads each node's RAW child list (so a duplicate direct
 * child still double-counts in a parent's mean, as before), an unmeasured/NaN own fraction falls back to
 * null, and a back-edge to a node still on the traversal stack (a cycle) contributes nothing and is flagged
 * — identical outcome to the former `path.has(id)` guard.
 */
function subtreeRollups(root: string, childrenOf: Children, fractionOf: FractionOf, flags: { cycle: boolean }): Map<string, number | null> {
  const kids = new Map<string, readonly string[]>(); // RAW child list per node (dupes kept for the mean)
  const state = new Map<string, 0 | 1>(); // 0 = on stack, 1 = done
  const order: string[] = []; // reverse-topological: each node appended after all its children
  const stack: string[] = [];
  const cursor = new Map<string, number>();

  const enter = (id: string): void => {
    state.set(id, 0);
    kids.set(id, childrenOf(id));
    stack.push(id);
    cursor.set(id, 0);
  };
  enter(root);
  while (stack.length > 0) {
    const id = stack[stack.length - 1];
    const list = kids.get(id)!;
    const i = cursor.get(id)!;
    if (i < list.length) {
      cursor.set(id, i + 1);
      const c = list[i];
      const s = state.get(c);
      if (s === 0) { flags.cycle = true; continue; } // back-edge to an on-stack ancestor → cycle, contributes nothing
      if (s === 1) continue; // already computed — a shared prerequisite (diamond); the fold reads its memoized value
      enter(c);
    } else {
      state.set(id, 1);
      order.push(id);
      stack.pop();
    }
  }

  const value = new Map<string, number | null>();
  for (const id of order) {
    const childVals: number[] = [];
    for (const child of kids.get(id)!) {
      const v = value.get(child); // undefined for a cycle back-edge (never folded on this side) → skip, as before
      if (v !== undefined && v !== null) childVals.push(v);
    }
    value.set(id, childVals.length > 0 ? clamp01(mean(childVals)) : cleanFraction(fractionOf(id)));
  }
  return value;
}

/**
 * The rollup verdict for `id`: the branch-normalized aggregate of its direct children's rollups, plus the
 * coverage (childCount / contributingChildCount), the node's own fraction, and a cycle flag. `childrenOf`
 * + `fractionOf` are injected (caller-defined relation/direction + metric reader), so this leaf names no
 * Society. Pure, cycle-safe, no clock.
 */
export function rollupOf(id: string, childrenOf: Children, fractionOf: FractionOf): RollupResult {
  const flags = { cycle: false };
  const value = subtreeRollups(id, childrenOf, fractionOf, flags);
  const children = childrenOf(id); // RAW (dupes kept, matching the fold + childCount)
  const childVals: number[] = [];
  for (const child of children) {
    // A DIRECT self-dependency (child === id) is a cycle with the queried root: it contributes nothing and
    // is flagged, exactly as the former `path.has(id)` guard did (the fold's own value for `id` is skipped
    // here so a self-edge never counts the node against itself). Deeper cycles are already handled in the fold.
    if (child === id) { flags.cycle = true; continue; }
    const v = value.get(child);
    if (v !== undefined && v !== null) childVals.push(v);
  }
  const fraction = childVals.length > 0 ? clamp01(mean(childVals)) : undefined;
  const own = cleanFraction(fractionOf(id)); // a NaN own metric → null (honest "unmeasured")
  return {
    fraction,
    value: fraction ?? (own === null ? undefined : own),
    childCount: children.length,
    contributingChildCount: childVals.length,
    ownFraction: own,
    cycleDetected: flags.cycle,
  };
}

/** True iff a node has any children (so a rolled-up badge is meaningful — it aggregates something). */
export function hasChildren(id: string, childrenOf: Children): boolean {
  return childrenOf(id).length > 0;
}
