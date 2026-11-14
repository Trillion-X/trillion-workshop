// src/workspace/ask-bar-change.mjs
//
// PURPOSE
//   The two decisions of the Ask bar (DockedComposer in global-composer.tsx) that need no screen: which "What is new" tour its pill offers, and
//   which example question its placeholder shows. Pure, so a test reads them without a page.
//
// NON-NEGOTIABLE INVARIANTS
//   1. The pill is the newest tour about a change (`changedAt`, with a start event) landed within `freshDays` and not in
//      the future, not taken, not the one dismissed; nothing is guessed about tours without a landing time.
//   2. The example is the one at `count` in order, wrapping; nothing is random.

const DAY_MS = 86400000;

/** @param {{ id: string, finished: boolean, changedAt: string | null, startEvent: unknown }[]} tours */
export function freshChange(tours, dismissed, now, freshDays) {
  const landed = tour => Date.parse(tour.changedAt);
  return tours
    .filter(tour => !tour.finished && tour.id !== dismissed && tour.changedAt && tour.startEvent && landed(tour) <= now && now - landed(tour) <= freshDays * DAY_MS)
    .sort((a, b) => landed(b) - landed(a))[0] ?? null;
}

export const exampleAt = (examples, count) => examples[count % examples.length];
