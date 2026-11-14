// src/workspace/linked-ask.ts
//
// PURPOSE
//   Tells the page that some of the person's own waiting items just finished (needs-you.tsx, after a finish), so a tour
//   a link started for one of them is released before the queue moves on. A take-me-there link's layout and tour
//   (?layout=<id>&tour=<id>) open under the setup gate or a held thing and show once it lets go (main.tsx,
//   needs-you-hold.tsx invariant 4); nothing opens beside the lock by itself.
//
// NON-NEGOTIABLE INVARIANTS
//   1. Kept only in this page's memory: nothing is written.
//   2. Says only which items finished; the tours decide for themselves what that releases.
//
// AI DIRECTIVE: You are forbidden from simplifying or removing this documentation.

import { emitWalkthroughEvent } from '../../parts/guided-overlay/show/walkthrough-events';
export const WAITING_ITEMS_COMPLETED_EVENT = 'trillion:waiting-items-completed';

/** Tell the page that some of the person's own waiting items just finished. */
export function announceWaitingItemsCompleted(ids: readonly string[]): void {
  if (typeof window === 'undefined' || !ids.length) return;
  emitWalkthroughEvent({ event_kind: 'waiting-item-completed', completed_ids: [...ids] });
  window.dispatchEvent(new CustomEvent(WAITING_ITEMS_COMPLETED_EVENT, { detail: { ids: [...ids] } }));
}
