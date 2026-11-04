// parts/guided-overlay/show/changed-tour.ts
//
// PURPOSE
//   A tour as the person's rules leave it: every step asked "how does this step show now?" through the one show-rules
//   seam (parts/ui/show/show-rules, subject `tour-step`), and given the words and the look the rules that change things
//   set on it. One edit made on the canvas for this step, every step of this tour or every tour is one such rule, so the
//   running tour and the canvas both draw the step from here and can never disagree.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A step's facts are its own fields plus the tour it belongs to (`tour`) and who wrote that tour (`tour_by`); the
//      rules decide over them, and nothing here names a field a rule may change.
//   2. The facts added to ask are taken off again: a changed step has exactly the step's own fields.
//   3. A tour no rule changes is handed back as the same object.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { showChanged } from '../../ui/show/show-rules/show-of';
import type { WalkthroughDefinition, WalkthroughStep } from '../read-data/walkthrough-eeaf';

/** The show-rules subject a tour step is asked under (show-rules.json `subjects`). */
export const STEP_SUBJECT = 'tour-step';

/** Who wrote a tour: a tour the person's AIs kept carries when it was saved. */
export const tourBy = (definition: WalkthroughDefinition): string => ((definition as { saved_at?: unknown }).saved_at ? 'ai' : 'trillion');

/** The facts one step is decided over: the step's own fields, the tour it is in and who wrote that tour. */
export const stepFacts = (definition: WalkthroughDefinition, step: WalkthroughStep): Record<string, unknown> => ({ ...step, tour: definition.id, tour_by: tourBy(definition) });

/** One step as the rules leave it. */
export function stepAsChanged(definition: WalkthroughDefinition, step: WalkthroughStep): WalkthroughStep {
  const facts = stepFacts(definition, step);
  const changed = showChanged(STEP_SUBJECT, facts);
  if (changed === facts) return step;
  const { tour: _tour, tour_by: _by, ...own } = changed;
  return own as unknown as WalkthroughStep;
}

/** The tour with every step as the rules leave it; the same tour when no rule changes any step. */
export function tourAsChanged(definition: WalkthroughDefinition): WalkthroughDefinition {
  let touched = false;
  const steps = definition.steps.map(step => {
    const changed = stepAsChanged(definition, step);
    if (changed !== step) touched = true;
    return changed;
  });
  return touched ? { ...definition, steps } : definition;
}
