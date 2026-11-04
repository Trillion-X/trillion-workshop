// packages/guided-overlay/engine/cursor-machine.ts
//
// PURPOSE
// The cursor + transition machine (engine mechanism M3) for the guided-overlay
// walkthrough. It moves a cursor over a (possibly branched) ordered list of
// steps — advance/retreat/jump/restart — and reports completion. PURE: every
// transition is a function of (definition, cursor, ...) returning a NEW cursor.
// History is kept so retreat is exact even across branches. The machine is blind
// to step content/placement/triggers — it reads only ids + branch maps (M8).

import { resolveBranch, type StepShape, type WalkthroughShape } from './branch-resolver';

export interface WalkthroughCursor {
  /** The step currently shown. */
  readonly currentStepId: string;
  /** Visited step ids, oldest first — the retreat stack. */
  readonly history: readonly string[];
  readonly status: 'active' | 'complete';
}

function indexOfStep(def: WalkthroughShape, id: string): number {
  return def.steps.findIndex((s) => s.id === id);
}

function stepExists(def: WalkthroughShape, id: string): boolean {
  return indexOfStep(def, id) >= 0;
}

/** The next step id in list order after `id`, or null if `id` is last/absent. */
function orderedNextId(def: WalkthroughShape, id: string): string | null {
  const i = indexOfStep(def, id);
  if (i < 0) return null;
  return def.steps[i + 1]?.id ?? null;
}

/** The step the cursor is on, or null if it points nowhere. */
export function currentStep(def: WalkthroughShape, cursor: WalkthroughCursor): StepShape | null {
  return def.steps.find((s) => s.id === cursor.currentStepId) ?? null;
}

/** Begin a walkthrough at its entry step . */
export function startWalkthrough(def: WalkthroughShape): WalkthroughCursor {
  return { currentStepId: def.entry_step, history: [], status: 'active' };
}

/**
 * Advance to the next step. On a branching step, `answer` routes via M8; otherwise
 * the next step in list order. When there is no next step, the cursor completes.
 * A completed cursor is returned unchanged.
 */
export function advance(
  def: WalkthroughShape,
  cursor: WalkthroughCursor,
  answer?: string,
): WalkthroughCursor {
  if (cursor.status === 'complete') return cursor;
  const step = currentStep(def, cursor);
  if (!step) return { ...cursor, status: 'complete' };

  const next = resolveBranch(step, answer, orderedNextId(def, step.id));
  if (next === null || !stepExists(def, next)) {
    return { ...cursor, status: 'complete' };
  }
  return { currentStepId: next, history: [...cursor.history, cursor.currentStepId], status: 'active' };
}

/** Go back to the previously visited step. No-op when history is empty. */
export function retreat(cursor: WalkthroughCursor): WalkthroughCursor {
  if (cursor.history.length === 0) return cursor;
  const history = cursor.history.slice(0, -1);
  const currentStepId = cursor.history[cursor.history.length - 1];
  return { currentStepId, history, status: 'active' };
}

/** Jump directly to a step (e.g. a replay hub picking a step). No-op if absent. */
export function jump(def: WalkthroughShape, cursor: WalkthroughCursor, stepId: string): WalkthroughCursor {
  if (!stepExists(def, stepId)) return cursor;
  return { currentStepId: stepId, history: [...cursor.history, cursor.currentStepId], status: 'active' };
}
