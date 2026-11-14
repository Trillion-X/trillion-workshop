// src/workspace/get-started-hold.mjs
//
// PURPOSE
//   Keeps the last good Get started description on screen. The setup screen and the required-setup gate both read the
//   same description every few seconds; a read that fails, or an answer that is not yet a real answer, must not replace
//   what the person was just shown. This module decides which description is shown, and nothing else.
//
// NON-NEGOTIABLE INVARIANTS
//   1. A failed read is `next === undefined || next === null`. It never produces a description: the previous one stays.
//   2. A new description whose required steps are all not known yet (`done === null`) is not a regression; it is held.
//   3. A new description carrying the `setup-policy` section or announce id, while the previous one had real steps
//      (`done` true or false), is held. The id names a policy notice, not a result, so it cannot clear a shown list.
//   4. With no previous good description, the new one is shown as it is, so a first answer still draws checking marks.
//   5. Pure: no fetch, no timers, no React. The screen and the gate each keep their own last good value.
//

/** The notice or section id that marks a policy answer rather than a result. */
export const SETUP_POLICY_ID = 'setup-policy';

const stepsOf = description => (Array.isArray(description?.sections) ? description.sections : []).flatMap(section => (Array.isArray(section?.steps) ? section.steps : []));

// A step whose state is proven: done is true or false (null is not known yet).
const hasRealSteps = description => stepsOf(description).some(step => step?.done === true || step?.done === false);

// Every required step is not known yet. Nothing required means nothing to hold for.
// The required steps are the ones listed in the setup steps section (src/account-screens.mjs getStartedFacts).
const requiredOf = description => (Array.isArray(description?.sections) ? description.sections : [])
  .filter(section => section?.id === 'setup-steps').flatMap(section => (Array.isArray(section?.steps) ? section.steps : []));
const requiredNotKnownYet = description => {
  const required = requiredOf(description);
  return required.length > 0 && required.every(step => step.done === null);
};

const isPolicyAnswer = description => description?.announce?.id === SETUP_POLICY_ID
  || (Array.isArray(description?.sections) && description.sections.some(section => section?.id === SETUP_POLICY_ID || section?.notice === SETUP_POLICY_ID));

/** The description to show after a read: `next` when it is a real answer, otherwise the last good `previous` (or null when
 *  there is none yet, in which case the caller shows its own failure or loading state). */
export function heldGetStarted(previous, next) {
  if (next === undefined || next === null) return previous ?? null;
  if (previous && (requiredNotKnownYet(next) || (isPolicyAnswer(next) && hasRealSteps(previous)))) return previous;
  return next;
}
