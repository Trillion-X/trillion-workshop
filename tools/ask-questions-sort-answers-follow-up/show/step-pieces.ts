// tools/ask-questions-sort-answers-follow-up/show/step-pieces.ts
//
// PURPOSE
//   What a page asked one step at a time shows of its progress, and where a new step opens. The progress is one piece per step
//   across the full width: the steps done solid, the current one half, the steps ahead faint (the person who answers the booking
//   asked for pieces per step over one continuous bar, Nov 24 2026). Which pieces are done is the shared step-progress projection
//   (../../ui/show/step-progress progressState and segmentFills); this file only names each piece, and ./FormSteps.tsx StepPieces
//   draws them for every page that asks one step at a time (the form page and the booking page). A new step opens at the top of
//   the page, so the person reads it from its heading: the step's key changes, the page goes to the top; the first step drawn
//   stays where the page put it.
//
// NON-NEGOTIABLE INVARIANTS
//   1. `piecesOf(at, count)` gives exactly `count` pieces. Before the end, the pieces before `at` are done, the piece at `at` is
//      current and the rest are ahead; at or past the end every piece is done.
//   2. `opensAtTop(before, now)` is true only when a step was drawn before and the step now drawn is another one.
//   3. `useStepOpensAtTop(stepKey)` is the one place a page's host takes the page to the top: after it is mounted, in an effect,
//      never while it renders.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.
import { useEffect, useRef } from 'react';
import { progressState, segmentFills } from '../../ui/show/step-progress/step-progress.ts';

export type Piece = 'done' | 'current' | 'ahead';

/** One piece per step: done, current or ahead (see invariant 1). */
export function piecesOf(at: number, count: number): Piece[] {
  if (count <= 0) return [];
  const state = progressState(Math.min(Math.max(at, 0), count - 1), count);
  return segmentFills(state).map((filled, index) => (at >= count || (filled && index < state.index) ? 'done' : index === state.index ? 'current' : 'ahead'));
}

/** Whether a newly drawn step opens at the top of the page (see invariant 2). */
export const opensAtTop = (before: string | null, now: string): boolean => before !== null && before !== now;

/** Takes the page to the top each time the step in view becomes another one (see invariants 2 and 3). */
export function useStepOpensAtTop(stepKey: string): void {
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (opensAtTop(shown.current, stepKey)) window.scrollTo({ top: 0 });
    shown.current = stepKey;
  }, [stepKey]);
}
