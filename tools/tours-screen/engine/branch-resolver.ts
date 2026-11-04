// packages/guided-overlay/engine/branch-resolver.ts
//
// PURPOSE
// The branch resolver (engine mechanism M8) for the guided-overlay walkthrough.
// A step may carry a `branch_map` that routes to the next step by the user's
// answer value. Resolution is a DATA lookup with a `default_next` fallback and an
// ordered fallback — never a coded branch (`if answer === 'pro'`). New routes are
// new DATA rows, not engine code.
//
// The engine reads only the STRUCTURAL shape of a definition (id + branch_map +
// ordered list). It is blind to content, triggers, placement, etc. — those are
// other mechanisms. This keeps the navigation core tiny and testable.

/** A step's answer→next routing (all DATA). */
export interface BranchMap {
  /** answer value → next step id. */
  readonly by_answer?: Readonly<Record<string, string>>;
  /** Where to go when no `by_answer` entry matches. */
  readonly default_next?: string;
}

/** The minimal step shape the navigation core reads. */
export interface StepShape {
  readonly id: string;
  readonly branch_map?: BranchMap;
}

/** The minimal walkthrough shape the navigation core reads. */
export interface WalkthroughShape {
  readonly entry_step: string;
  readonly steps: readonly StepShape[];
}

/**
 * Resolve the next step id for `step` given an optional `answer` and the ordered
 * fallback (the next step in list order, or null at the end).
 *
 * Priority — all DATA-driven:
 *   1. `branch_map.by_answer[answer]` when the answer matches a route.
 *   2. `branch_map.default_next` when a branch map exists but no route matched.
 *   3. `orderedNext` (plain linear advance) when there is no branch map.
 *
 * Returns `null` only when nothing routes anywhere (end of a linear list with no
 * branch map) — the caller treats that as completion.
 */
export function resolveBranch(
  step: StepShape,
  answer: string | undefined,
  orderedNext: string | null,
): string | null {
  const bm = step.branch_map;
  if (!bm) return orderedNext;
  if (answer !== undefined && bm.by_answer && Object.prototype.hasOwnProperty.call(bm.by_answer, answer)) {
    return bm.by_answer[answer];
  }
  if (bm.default_next !== undefined) return bm.default_next;
  return orderedNext;
}
