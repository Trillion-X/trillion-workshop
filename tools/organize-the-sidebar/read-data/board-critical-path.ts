// packages/group/read-data/board-critical-path.ts
//
// The CRITICAL-PATH primitive: over a dependency DAG of goals, find the longest EFFORT chain that gates a
// root goal, and the goals with zero slack (the true bottlenecks — a slip there slips the whole vision
// one-for-one). A vision's sub-goals depend on each other ("Run 5k" must finish before "Marathon"); the
// vision cannot finish until its slowest prerequisite chain finishes. This is the blind CPM engine: given a
// root, a `childrenOf` accessor (a goal's direct PREREQUISITES) and a `durationHoursOf` accessor (effort-
// hours left, e.g. forecast.hoursRemaining), it runs a forward pass (earliest finish = own effort + the
// longest prerequisite chain) and a backward pass (latest finish without slipping the root) to derive each
// goal's slack; zero-slack goals are critical. It names NO Society (no metric/relation/deadline vocab) —
// both accessors are injected, exactly like board-rollup.
//
// HONESTY (fail-closed, per the convergence review):
//   * The sum is CRITICAL EFFORT, not a wall-clock date — it knows nothing of capacity, parallel labor, or
//     cadence. `finishHours` is effort-hours along the critical chain.
//   * ANY goal in the reachable set with no measured effort -> `finishHours: null` (the schedule is not
//     authoritative); the ids are surfaced so the product can prompt "add an estimate". `knownFinishHours`
//     still gives the lower bound from the measured goals.
//   * A dependency CYCLE is an impossible plan -> fail closed (`finishHours: null`, `cycleDetected: true`),
//     NOT partial-skipped like rollup's aggregation.
//   * The bottleneck is SLACK-based (zero-slack goals), reported as a set; a single `primaryBottleneckId`
//     is only a deterministic representative (largest effort among the zero-slack goals).
// Pure — no clock, duplicate prerequisites de-duped so a doubled connector cannot overweight a dependency.

const EPS = 1e-9;
/** DoS bound: the reachable dependency closure a single critical-path run will walk. A real vision has a
 *  handful of goals; a crafted/corrupted connector graph of millions would force a full O(V+E) walk +
 *  one output node per id. Past this the run fails closed (no schedule) rather than freezing the panel. */
const MAX_CRITICAL_NODES = 100_000;
/** A sane effort-hours ceiling. A finite-but-huge duration (e.g. a persisted `Number.MAX_VALUE`) is not
 *  rejected by `Number.isFinite`, yet summed along a chain it overflows to Infinity → slack `NaN` → the
 *  bottleneck detection silently breaks. Beyond this bound the estimate is garbage → treated as unknown. */
const MAX_DURATION_HOURS = 1e9;

/** One goal in the reachable dependency closure, with its schedule position. */
export interface CriticalPathNode {
  readonly id: string;
  readonly durationHours: number | null;
  /** Own effort + the longest prerequisite chain beneath it (unknown effort counts as 0 here). */
  readonly earliestFinishHours: number;
  /** How much this goal can slip without moving the root's finish; 0 (within EPS) = critical. */
  readonly slackHours: number;
  readonly critical: boolean;
}

/** The critical effort chain that gates a root goal and the goals that dominate it. */
export interface CriticalPathResult {
  readonly rootId: string;
  /** Critical effort-hours to finish the root; null when any effort is unknown or a cycle exists. */
  readonly finishHours: number | null;
  /** Lower-bound effort from the measured goals (unknown treated as 0) — always a number. */
  readonly knownFinishHours: number;
  /** A representative zero-slack chain, root -> deepest prerequisite. */
  readonly criticalPath: readonly string[];
  /** Every zero-slack goal — the honest bottleneck set (may be plural across equal chains). */
  readonly bottleneckIds: readonly string[];
  /** A deterministic single highlight: the largest-effort zero-slack goal; null when none measured. */
  readonly primaryBottleneckId: string | null;
  /** Per-goal schedule readout over the reachable closure. */
  readonly nodes: readonly CriticalPathNode[];
  /** Reachable goals with no measured effort — the estimate is non-authoritative while non-empty. */
  readonly unknownDurationIds: readonly string[];
  /** A dependency cycle was found — the plan is impossible; the schedule is not computed. */
  readonly cycleDetected: boolean;
}

function durationOrNull(raw: number | null): number | null {
  // Also reject a finite-but-absurd duration (> MAX_DURATION_HOURS): summed along a chain it would
  // overflow the schedule to Infinity → NaN slack. An out-of-range estimate is unknown, not authoritative.
  return raw !== null && Number.isFinite(raw) && raw >= 0 && raw <= MAX_DURATION_HOURS ? raw : null;
}

function emptyResult(rootId: string, unknownDurationIds: string[], cycleDetected: boolean): CriticalPathResult {
  return {
    rootId, finishHours: null, knownFinishHours: 0, criticalPath: [], bottleneckIds: [],
    primaryBottleneckId: null, nodes: [], unknownDurationIds, cycleDetected,
  };
}

/**
 * Compute the critical effort path from `rootId`. Two passes over the reachable prerequisite closure:
 * forward (earliest finish) then backward (latest finish without slipping the root) -> slack. Zero-slack
 * goals are the bottlenecks. Fails closed on a dependency cycle. Deterministic: children are visited in the
 * caller's order, ties resolved by first-wins, so the representative chain is stable.
 */
export function criticalPathOf(
  rootId: string,
  childrenOf: (id: string) => readonly string[],
  durationHoursOf: (id: string) => number | null,
): CriticalPathResult {
  // 1. Walk the reachable closure, de-duping prerequisites and detecting a cycle. `order` is a reverse-
  //    topological list (each goal appears AFTER all its prerequisites) built from DFS post-order.
  const kids = new Map<string, string[]>();
  const order: string[] = [];
  const state = new Map<string, 0 | 1>(); // 0 = on stack, 1 = done
  let cycle = false;

  // ITERATIVE DFS (explicit stack) — a recursive walk here would blow the JS call stack on a deep
  // dependency chain built from crafted/persisted board connectors (a `root <- n1 <- n2 <- …` of tens
  // of thousands of goals reaches criticalPathOf live from the panel via connector-derived childrenOf).
  // This is the same reachable-deep-graph hardening the board-tree read leaf already adopted (walkTree).
  // Semantics are byte-identical to the former recursion: duplicate prerequisites are dropped; a node is
  // appended to `order` only AFTER all its prerequisites (post-order → a valid reverse-topological list);
  // a back-edge to a node still on the stack (state 0), including a self-dependency c === id, flags the
  // cycle and fails closed, never silently repaired.
  const stack: string[] = [];
  const childCursor = new Map<string, number>(); // next unvisited child index for each on-stack node
  const enter = (id: string): void => {
    state.set(id, 0);
    const seen = new Set<string>();
    const list: string[] = [];
    for (const c of childrenOf(id)) {
      if (seen.has(c)) continue; // drop a duplicate connector (same prerequisite wired twice) as noise
      seen.add(c);
      list.push(c);
    }
    kids.set(id, list);
    stack.push(id);
    childCursor.set(id, 0);
  };
  let tooLarge = false;
  if (state.get(rootId) === undefined) enter(rootId);
  while (stack.length > 0) {
    // Fail closed on a pathological graph before it walks millions of nodes / allocates millions of
    // output rows (`state.size` = nodes entered so far). No schedule beats a frozen panel.
    if (state.size > MAX_CRITICAL_NODES) { tooLarge = true; break; }
    const id = stack[stack.length - 1];
    const list = kids.get(id)!;
    const i = childCursor.get(id)!;
    if (i < list.length) {
      childCursor.set(id, i + 1);
      const c = list[i];
      const s = state.get(c);
      if (s === 0) { cycle = true; continue; } // on the stack → cycle (incl. self-dependency), fail closed
      if (s === 1) continue; // already finished — a shared prerequisite, not a cycle
      enter(c);
    } else {
      state.set(id, 1);
      order.push(id);
      stack.pop();
    }
  }

  // Pathological graph → fail closed with no schedule (before any per-node allocation over a partial walk).
  if (tooLarge) return emptyResult(rootId, [], false);

  // Memoize each duration ONCE over the reachable set: `durationHoursOf` is called in four passes
  // (unknowns, forward, backward, chain) — reading it once guarantees every pass agrees (an impure or
  // expensive accessor can no longer make `unknownDurationIds`/slack/critical-path disagree) and bounds
  // the accessor cost to O(nodes). `?? null` is safe because a stored `0` is not nullish.
  const durationById = new Map<string, number | null>();
  for (const id of order) durationById.set(id, durationOrNull(durationHoursOf(id)));
  const durOf = (id: string): number | null => durationById.get(id) ?? null;
  const unknownDurationIds = order.filter((id) => durOf(id) === null);

  if (cycle) return emptyResult(rootId, unknownDurationIds, true);

  // 2. Forward pass in reverse-topo order (prerequisites first): earliest finish = own effort + the longest
  //    prerequisite's earliest finish. Unknown effort counts as 0 for the structural longest-path.
  const ef = new Map<string, number>();
  for (const id of order) {
    let maxChild = 0;
    for (const c of kids.get(id) ?? []) maxChild = Math.max(maxChild, ef.get(c) ?? 0);
    ef.set(id, (durOf(id) ?? 0) + maxChild);
  }
  const knownFinishHours = ef.get(rootId) ?? 0;

  // 3. Backward pass in topo order (dependents first): a prerequisite must finish before its dependent's own
  //    work begins, so its latest finish <= dependent.latestFinish - dependent.ownEffort. Root anchors at EF.
  const lf = new Map<string, number>();
  lf.set(rootId, knownFinishHours);
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i];
    const latest = lf.get(id) ?? knownFinishHours;
    const start = latest - (durOf(id) ?? 0);
    for (const c of kids.get(id) ?? []) {
      lf.set(c, Math.min(lf.get(c) ?? Infinity, start));
    }
  }

  // 4. Slack + critical (zero-slack) set.
  const nodes: CriticalPathNode[] = order.map((id) => {
    const e = ef.get(id) ?? 0;
    const slack = (lf.get(id) ?? e) - e;
    return { id, durationHours: durOf(id), earliestFinishHours: e, slackHours: slack, critical: Math.abs(slack) <= EPS };
  });
  const bottleneckIds = nodes.filter((n) => n.critical).map((n) => n.id);
  // The primary highlight is the largest-effort zero-slack goal, but a goal with ZERO remaining effort is not
  // "the work to do" — it is already done. Starting the threshold at 0 (not -1) means an all-complete plan
  // (every duration 0) yields NO primary bottleneck, so a downstream "what's next" surface shows nothing to do
  // instead of pointing at a finished goal.
  let primaryBottleneckId: string | null = null;
  let primaryHours = 0;
  for (const n of nodes) {
    if (n.critical && n.durationHours !== null && n.durationHours > primaryHours) {
      primaryHours = n.durationHours;
      primaryBottleneckId = n.id;
    }
  }

  // 5. Representative critical chain: from the root, step to a zero-slack prerequisite whose earliest finish
  //    feeds the parent's (own effort + child EF == parent EF), until a leaf.
  const criticalPath: string[] = [];
  let cursor: string | null = rootId;
  const guard = new Set<string>();
  while (cursor !== null && !guard.has(cursor)) {
    guard.add(cursor);
    criticalPath.push(cursor);
    const parentEf = ef.get(cursor) ?? 0;
    const own = durOf(cursor) ?? 0;
    let next: string | null = null;
    for (const c of kids.get(cursor) ?? []) {
      const cEf = ef.get(c) ?? 0;
      if (Math.abs(parentEf - (own + cEf)) <= EPS && Math.abs((lf.get(c) ?? cEf) - cEf) <= EPS) { next = c; break; }
    }
    cursor = next;
  }

  return {
    rootId,
    finishHours: unknownDurationIds.length === 0 ? knownFinishHours : null,
    knownFinishHours,
    criticalPath,
    bottleneckIds,
    primaryBottleneckId,
    nodes,
    unknownDurationIds,
    cycleDetected: false,
  };
}
