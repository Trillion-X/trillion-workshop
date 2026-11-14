// M022 compares an explicitly selected source condition in the existing
// isometric instruction scene. Every state is illustrative, not an outcome.
import { renderInstructionCase } from '../../../anatomy-contact-replacement/instruction-case.mjs';

export const INITIAL_CASE = Object.freeze({
  sourceCondition: 'not-checked',
  candidateRoute: false,
});

export const SOURCE_CONDITIONS = Object.freeze(['not-checked', 'permits-reuse', 'requires-repetition']);

const labels = Object.freeze({
  tutor: 'No second person is depicted; the lesson does not invent another person’s testimony.',
  learner: 'A learner at a desk examining a method in an open book.',
  book: 'An open book carrying the method under examination.',
  question: 'A question about whether an existing answer resolves the case.',
});

export function caseScene({ ...state } = {}) {
  const next = { ...INITIAL_CASE, ...state };
  if (!SOURCE_CONDITIONS.includes(next.sourceCondition)) throw new TypeError(`Unknown M022 source condition: ${String(next.sourceCondition)}`);
  if (typeof next.candidateRoute !== 'boolean') throw new TypeError('M022 candidateRoute must be boolean');

  const permitsReuse = next.sourceCondition === 'permits-reuse';
  const requiresRepetition = next.sourceCondition === 'requires-repetition';
  const compareRoute = requiresRepetition && next.candidateRoute;
  const figure = renderInstructionCase({
    open: 1,
    ink: 1,
    bookVisible: 1,
    instructionLink: 1,
    instructionRoute: 1,
    use: permitsReuse ? 0.84 : null,
    attempt: requiresRepetition ? 0.58 : permitsReuse ? 0.12 : 0,
    // The shared Anatomy route separates only for the conditional comparison.
    instructionSplit: compareRoute ? 0.72 : undefined,
    // A route that requires repetition keeps its repeated marks until the
    // candidate checks the existing answer first.
    duplicateInstructions: requiresRepetition && !compareRoute ? 0 : 1,
    tutorVisible: 0,
    labels,
  });

  return {
    ...figure,
    viewport: [650, 250, 900, 700],
    state: {
      ...figure.state,
      ...next,
      permitsReuse,
      requiresRepetition,
      compareRoute,
      illustrative: true,
      learningResult: null,
    },
  };
}
