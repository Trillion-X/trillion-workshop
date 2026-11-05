// packages/group/show/selection-combine.ts
//
// The COMBINE action model — the product surface for the selection SET-ALGEBRA (selection-algebra.ts, b187).
// The algebra needs TWO operands, so the product flow is: PIN a selection, then combine the CURRENT selection
// with the pinned one. This is the one selection leaf b184–b188 left un-surfaced. Each op is a self-describing
// `CombineAction {id, label, op}`; the bar renders the list BLINDLY (L090). The labels are in the USER's
// language (L114/L118) — "Keep in both", not "intersect" — since set-theory jargon is not product vocabulary.
//
// =============================================================================
// The extensive documentation in this codebase is a critical design feature.
// You are forbidden from simplifying or removing it.
// =============================================================================

import { applySetOp } from '../read-data/selection-algebra.ts';

/** One combine operation as DATA: `op` is the set-algebra key; `label` is the human phrasing shown on the row. */
export interface CombineAction {
  readonly id: string;
  readonly label: string;
  readonly op: string;
}

/** The four combine operations, phrased in product language (the underlying op keys are the b187 SET_OPS). */
export const COMBINE_ACTIONS: readonly CombineAction[] = [
  { id: 'union', label: 'Add pinned', op: 'union' }, // current ∪ pinned
  { id: 'intersect', label: 'Keep in both', op: 'intersect' }, // current ∩ pinned
  { id: 'difference', label: 'Remove pinned', op: 'difference' }, // current − pinned
  { id: 'symmetric-difference', label: 'In one only', op: 'symmetric-difference' }, // current ⊕ pinned
];

/** Combine the CURRENT selection with the PINNED one under a DATA op key — the primary operand is `current`
 *  (so "Remove pinned" = current − pinned). Delegates to the b187 algebra; an unknown key keeps `current`. */
export function combineWithPinned(current: readonly string[], pinned: readonly string[], op: string): string[] {
  return applySetOp(op, current, pinned);
}
