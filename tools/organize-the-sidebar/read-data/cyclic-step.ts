// packages/group/read-data/cyclic-step.ts
//
// Cyclic list stepping — the tiny generative primitive behind "go to the next / previous X, wrapping
// around". Given an ordered id list, the current id (or null = not on the list yet), and a direction, it
// returns the id to move to: from nowhere, forward starts at the first and backward at the last; from a
// member, it wraps at the ends. Pure + deterministic, names nothing about matches/tabs/slides — it drives
// search-match navigation (next/prev match), and is equally the shape of tab-order and present-mode cycling.

/**
 * The next id when stepping `delta` (+1 forward, -1 back) through `ids`, wrapping cyclically. `currentId`
 * absent (or not in the list) enters from the near end (forward → first, back → last). Returns null only
 * when the list is empty.
 */
export function nextInCycle(ids: readonly string[], currentId: string | null | undefined, delta: 1 | -1): string | null {
  if (ids.length === 0) return null;
  const cur = currentId != null ? ids.indexOf(currentId) : -1;
  if (cur < 0) return delta > 0 ? ids[0] : ids[ids.length - 1];
  return ids[(cur + delta + ids.length) % ids.length];
}
