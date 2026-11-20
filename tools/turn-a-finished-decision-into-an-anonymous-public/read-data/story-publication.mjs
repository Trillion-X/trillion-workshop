// tools/turn-a-finished-decision-into-an-anonymous-public/read-data/story-publication.mjs
//
// Whether a finished decision is written as a public story now. Ported from the old app's src/person-store.mjs
// (storiesOn, writeOneStory) as pure decisions; the owner's store reads the facts and does the writing.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Only a decision whose owner chose stories on is written. The choice is the owner's own, else the default row,
//      and it is read by tools/choose-whether-my-decisions-are-shared-show (sharingChoice), never re-decided here.
//   2. A decision not yet finished is never written.
//   3. A story taken down is never written again, however the owner's stories setting changes later.
//   4. A story is written once per result basis: a new result (or the decision itself, when none) makes a new basis.
import { sharingChoice } from '../../choose-whether-my-decisions-are-shared-show/src/sharing-choice.mjs';
import { isFinished, latestResult } from './story-facts.mjs';

/** Whether this decision is told as a story: the owner's own choice, else the default row for decisions made then. */
export const storiesOn = (chosen, row, madeAt) => sharingChoice(chosen, row, madeAt);

/** The basis a story is written against: the latest result's time, else the decision's own. */
export const basisOf = record => latestResult(record)?.at ?? 'decided';

/**
 * What to do with a finished decision's story: `write` (new or changed since its last write), `unchanged` (already
 * written for this basis), `withdrawn` (taken down, stays down), or `skip` (stories off, or not finished).
 */
export function storyStep({ on, record, saved }) {
  if (!on || !isFinished(record)) return 'skip';
  if (saved?.withdrawn) return 'withdrawn';
  if (saved?.basis === basisOf(record)) return 'unchanged';
  return 'write';
}
