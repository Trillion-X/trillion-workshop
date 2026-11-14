// parts/ui/show/step-mark/StepMark.tsx
//
// PURPOSE
//   The mark beside one step whose state is proven somewhere else (a setup step an owner checks, a guide's numbered
//   instruction): its number while it is still to do, the same round tick the shared steps checklist draws once it is
//   done, and a dashed ring while its state could not be read. One mark for every list of steps, so no screen draws its
//   own circle, tick or colour.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Read-only: the mark shows a state it is given and is never a control (a step the person ticks is the shared
//      steps checklist's Checkbox, which wears the same success tick).
//   2. No product words: the number and the words a screen reader hears are the caller's.
//   3. The look is screen-look/show/step-mark.css: the done fill is the look's success colour, never ink or the accent.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import * as React from 'react';

/** done: proven done; todo: still to do; unknown: its state could not be read; checking: its state is not known yet
 *  (a calm pulsing ring, never a not-done mark). */
export type StepMarkState = 'done' | 'todo' | 'unknown' | 'checking';
/** `n` is the step's number; a step still to do with no number is an empty hairline ring (waiting). */
export type StepMarkProps = { state: StepMarkState; n?: number; className?: string };

/** A step's state from its proven `done`: true is done, false is to do, null is unreadable when `nullIsUnknown`. */
export function stepMarkState(done: boolean | null | undefined, nullIsUnknown = false): StepMarkState {
  if (done === true) return 'done';
  return done === null && nullIsUnknown ? 'unknown' : 'todo';
}

/** One step's mark: its number, or the round tick once done. */
export function StepMark({ state, n, className }: StepMarkProps) {
  return (
    <span className={['step-mark', className].filter(Boolean).join(' ')} data-state={state} aria-hidden="true">
      {state === 'done' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      ) : state === 'checking' ? null : n}
    </span>
  );
}
